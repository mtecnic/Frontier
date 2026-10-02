import { pool, q, q1 } from './db.ts';
import { notFound, type Router } from './http.ts';
import { now } from './clock.ts';
import { auditLedger, lastNightlyRun, runNightly } from './nightly.ts';
import {
  createPromotion,
  createStation,
  listPromotions,
  listStations,
  updatePromotion,
  updateStation,
} from './business.ts';
import { env } from './env.ts';

function idParam(v: string | undefined): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw notFound();
  return n;
}

export function registerAdminRoutes(r: Router) {
  r.get('/admin/stats', 'admin', async () => {
    const at = new Date(now());
    const stats = await q1(
      pool,
      `SELECT (SELECT count(*) FROM users WHERE deleted_at IS NULL) AS users,
              (SELECT count(*) FROM users WHERE deleted_at IS NULL AND last_open_at > $1::timestamptz - interval '7 days') AS active7d,
              (SELECT count(*) FROM users WHERE deleted_at IS NULL AND last_open_at > $1::timestamptz - interval '1 day') AS active1d,
              (SELECT count(*) FROM parcels) AS parcels,
              (SELECT count(*) FROM parcels WHERE has_store) AS stores,
              (SELECT count(*) FROM parcels WHERE has_spook) AS spooks,
              (SELECT coalesce(sum(cash_cents), 0) FROM users WHERE deleted_at IS NULL) AS money_supply_cents,
              (SELECT count(*) FROM flags WHERE resolved_at IS NULL) AS open_flags,
              (SELECT count(*) FROM users WHERE frozen AND deleted_at IS NULL) AS frozen,
              (SELECT count(*) FROM prizes WHERE claimed_by IS NULL AND expires_at > $1) AS live_prizes,
              (SELECT count(*) FROM deeds WHERE time > $1::timestamptz - interval '1 day' AND kind = 'sale') AS sales24h`,
      [at],
    );
    return { stats, nightly: await lastNightlyRun(), publicUrl: env.PUBLIC_URL };
  });

  r.get('/admin/flags', 'admin', async (ctx) => {
    const all = ctx.query.get('status') === 'all';
    return q(
      pool,
      `SELECT f.*, u.username, u.frozen, u.email, r.username AS resolved_by_name
         FROM flags f JOIN users u ON u.id = f.user_id LEFT JOIN users r ON r.id = f.resolved_by
        ${all ? '' : 'WHERE f.resolved_at IS NULL'}
        ORDER BY f.created_at DESC LIMIT 300`,
    );
  });

  r.post('/admin/flags/:id/resolve', 'admin', async (ctx) => {
    const id = idParam(ctx.params.id);
    const row = await q1(
      pool,
      'UPDATE flags SET resolved_at = $2, resolved_by = $3, note = $4 WHERE id = $1 RETURNING *',
      [id, new Date(now()), ctx.user!.id, typeof ctx.body?.note === 'string' ? ctx.body.note.slice(0, 500) : null],
    );
    if (!row) throw notFound('No such flag');
    return row;
  });

  r.get('/admin/users', 'admin', async (ctx) => {
    const s = (ctx.query.get('search') ?? '').trim();
    return q(
      pool,
      `SELECT id, username, email, cash_cents, frozen, is_admin, created_at, last_open_at, deleted_at,
              (SELECT count(*) FROM parcels p WHERE p.owner_id = users.id) AS parcels,
              (SELECT count(*) FROM flags f WHERE f.user_id = users.id AND f.resolved_at IS NULL) AS open_flags
         FROM users
        WHERE ($1 = '' OR username ILIKE '%' || $1 || '%' OR email ILIKE '%' || $1 || '%' OR id::text = $1)
        ORDER BY last_open_at DESC LIMIT 100`,
      [s],
    );
  });

  r.get('/admin/users/:id', 'admin', async (ctx) => {
    const id = idParam(ctx.params.id);
    const user = await q1(
      pool,
      `SELECT id, username, email, cash_cents, lawyers, permits, spooks, flares, frozen, is_admin, created_at,
              last_open_at, last_fix_lat, last_fix_lng, last_fix_at, last_fix_acc, signup_ip, deleted_at,
              (SELECT coalesce(sum(amount_cents), 0) FROM ledger WHERE user_id = users.id) AS ledger_cents
         FROM users WHERE id = $1`,
      [id],
    );
    if (!user) throw notFound('No such user');
    const [flags, fixes, deeds, ledger, parcels] = await Promise.all([
      q(pool, 'SELECT * FROM flags WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [id]),
      q(pool, 'SELECT time, lat, lng, accuracy, accepted, reason FROM fix_log WHERE user_id = $1 ORDER BY time DESC LIMIT 100', [id]),
      q(
        pool,
        `SELECT d.*, f.username AS from_name, t.username AS to_name FROM deeds d
           LEFT JOIN users f ON f.id = d.from_user LEFT JOIN users t ON t.id = d.to_user
          WHERE d.from_user = $1 OR d.to_user = $1 ORDER BY d.time DESC LIMIT 100`,
        [id],
      ),
      q(
        pool,
        `SELECT l.*, o.username AS other FROM ledger l LEFT JOIN users o ON o.id = l.other_user_id
          WHERE l.user_id = $1 ORDER BY l.id DESC LIMIT 100`,
        [id],
      ),
      q(pool, 'SELECT count(*) AS n, coalesce(sum(max_price_cents), 0) AS value FROM parcels WHERE owner_id = $1', [id]),
    ]);
    return { user, flags, fixes, deeds, ledger, parcels: parcels[0] };
  });

  r.post('/admin/users/:id/freeze', 'admin', async (ctx) => {
    const id = idParam(ctx.params.id);
    const frozen = !!ctx.body?.frozen;
    const row = await q1(pool, 'UPDATE users SET frozen = $2 WHERE id = $1 RETURNING id, username, frozen', [id, frozen]);
    if (!row) throw notFound('No such user');
    if (!frozen && ctx.body?.resolveFlags) {
      await pool.query('UPDATE flags SET resolved_at = $2, resolved_by = $3, note = coalesce(note, $4) WHERE user_id = $1 AND resolved_at IS NULL', [
        id,
        new Date(now()),
        ctx.user!.id,
        'Cleared',
      ]);
    }
    return row;
  });

  r.get('/admin/promotions', 'admin', () => listPromotions());
  r.post('/admin/promotions', 'admin', (ctx) => createPromotion(ctx.body, now()));
  r.patch('/admin/promotions/:id', 'admin', (ctx) => updatePromotion(idParam(ctx.params.id), ctx.body));
  r.delete('/admin/promotions/:id', 'admin', (ctx) => updatePromotion(idParam(ctx.params.id), { active: false }));

  r.get('/admin/qr', 'admin', () => listStations());
  r.post('/admin/qr', 'admin', (ctx) => createStation(ctx.body, now()));
  r.patch('/admin/qr/:id', 'admin', (ctx) => updateStation(idParam(ctx.params.id), ctx.body));

  r.post('/admin/nightly', 'admin', async () => (await runNightly({ force: true })) ?? { skipped: true });
  r.post('/admin/audit', 'admin', async () => auditLedger(now()));
}
