import { CONFIG, DAY_MS, HOUR_MS } from '../shared/config.ts';
import { pool, q, q1, tx } from './db.ts';
import { env } from './env.ts';
import { now } from './clock.ts';
import { raiseFlag } from './flags.ts';
import { pruneExpiredPrizes, spawnPrizes } from './prizes.ts';
import { buildLeaderboards } from './boards.ts';

export function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** Every user's cash must equal the sum of their ledger rows. Mismatches are flagged. */
export async function auditLedger(at: number): Promise<{ checked: number; mismatches: { userId: number; cash: number; ledger: number }[] }> {
  const rows = await q<{ id: number; cash_cents: number; ledger: number }>(
    pool,
    `SELECT u.id, u.cash_cents, coalesce(l.total, 0) AS ledger
       FROM users u LEFT JOIN (SELECT user_id, sum(amount_cents) AS total FROM ledger GROUP BY user_id) l ON l.user_id = u.id`,
  );
  const mismatches = rows
    .filter((r) => r.cash_cents !== r.ledger)
    .map((r) => ({ userId: r.id, cash: r.cash_cents, ledger: r.ledger }));
  for (const m of mismatches) await raiseFlag(pool, m.userId, 'ledger_mismatch', m, at);
  return { checked: rows.length, mismatches };
}

/** New accounts whose purchases mostly pay one seller look like a second account feeding the first. */
export async function checkFeeders(at: number): Promise<number> {
  const rows = await q<{ buyer: number; seller: number; paid: number; total: number; n: number }>(
    pool,
    `WITH pay AS (
       SELECT d.to_user AS buyer, d.from_user AS seller, sum(d.seller_cents) AS paid, count(*) AS n
         FROM deeds d JOIN users u ON u.id = d.to_user
        WHERE d.kind = 'sale' AND d.from_user IS NOT NULL AND u.deleted_at IS NULL AND u.created_at > $1
        GROUP BY 1, 2)
     SELECT buyer, seller, paid, sum(paid) OVER (PARTITION BY buyer) AS total, sum(n) OVER (PARTITION BY buyer) AS n FROM pay`,
    [new Date(at - CONFIG.FLAG_FEEDER_ACCOUNT_DAYS * DAY_MS)],
  );
  let flagged = 0;
  for (const r of rows) {
    if (r.n < CONFIG.FLAG_FEEDER_MIN_PURCHASES || r.total <= 0) continue;
    if (r.paid / r.total >= CONFIG.FLAG_FEEDER_SHARE) {
      if (await raiseFlag(pool, r.buyer, 'feeds_one_seller', { seller: r.seller, paidCents: r.paid, totalCents: r.total, purchases: r.n }, at, 7 * DAY_MS))
        flagged++;
    }
  }
  const heavy = await q<{ to_user: number; n: number }>(
    pool,
    `SELECT to_user, count(*) AS n FROM deeds WHERE kind = 'sale' AND time > $1 GROUP BY to_user HAVING count(*) > $2`,
    [new Date(at - DAY_MS), CONFIG.FLAG_PURCHASES_PER_DAY],
  );
  for (const h of heavy) if (await raiseFlag(pool, h.to_user, 'purchases_per_day', { count: h.n }, at)) flagged++;
  return flagged;
}

async function cleanup(at: number) {
  const out: Record<string, number> = {};
  const run = async (name: string, sql: string, params: unknown[]) => {
    const r = await pool.query(sql, params);
    out[name] = r.rowCount ?? 0;
  };
  await run('sessions', 'DELETE FROM sessions WHERE expires_at < $1', [new Date(at)]);
  await run('login_requests', 'DELETE FROM login_requests WHERE created_at < $1', [new Date(at - 2 * DAY_MS)]);
  await run('idempotency', 'DELETE FROM idempotency WHERE created_at < $1', [new Date(at - 7 * DAY_MS)]);
  await run('fix_log', 'DELETE FROM fix_log WHERE time < $1', [new Date(at - 30 * DAY_MS)]);
  out.prizes = await pruneExpiredPrizes(pool, at);
  return out;
}

/**
 * The nightly job: spawn prizes, rebuild the six boards, audit the ledger,
 * look for feeder accounts and prune old rows. Runs at most once per UTC day
 * unless forced; a run that died more than two hours ago may be retried.
 */
export async function runNightly(opts: { force?: boolean; at?: number } = {}): Promise<Record<string, unknown> | null> {
  const at = opts.at ?? now();
  const day = utcDay(at);
  const claimed = await q1(
    pool,
    `INSERT INTO job_runs (job, day, started_at) VALUES ('nightly', $1, $2)
     ON CONFLICT (job, day) DO UPDATE SET started_at = EXCLUDED.started_at, finished_at = NULL
       WHERE $3 OR (job_runs.finished_at IS NULL AND job_runs.started_at < $4)
     RETURNING day`,
    [day, new Date(at), !!opts.force, new Date(at - 2 * HOUR_MS)],
  );
  if (!claimed) return null;

  const result: Record<string, unknown> = { day };
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      result[name] = await fn();
    } catch (err) {
      console.error(`nightly ${name} failed:`, err);
      result[name] = { error: (err as Error).message };
    }
  };
  await step('prizes', () => spawnPrizes(pool, at));
  await step('leaderboards', () =>
    tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(4242001)');
      return buildLeaderboards(c, day);
    }),
  );
  await step('ledgerAudit', async () => {
    const a = await auditLedger(at);
    return { checked: a.checked, mismatches: a.mismatches.length };
  });
  await step('flags', () => checkFeeders(at));
  await step('cleanup', () => cleanup(at));
  await pool.query("UPDATE job_runs SET finished_at = $2, result = $3 WHERE job = 'nightly' AND day = $1", [
    day,
    new Date(now()),
    JSON.stringify(result),
  ]);
  console.log('nightly job finished', JSON.stringify(result));
  return result;
}

/** Check once a minute; run after NIGHTLY_HOUR_UTC if today's run hasn't happened. */
export function startNightlyScheduler(): void {
  if (!env.NIGHTLY_IN_PROCESS) return;
  const tick = () => {
    const t = now();
    if (new Date(t).getUTCHours() < env.NIGHTLY_HOUR_UTC) return;
    runNightly({ at: t }).catch((err) => console.error('nightly job error', err));
  };
  setTimeout(tick, 5_000).unref();
  setInterval(tick, 60_000).unref();
}

export async function lastNightlyRun() {
  return q1<{ day: string; started_at: Date; finished_at: Date | null; result: unknown }>(
    pool,
    "SELECT to_char(day, 'YYYY-MM-DD') AS day, started_at, finished_at, result FROM job_runs WHERE job = 'nightly' ORDER BY day DESC LIMIT 1",
  );
}
