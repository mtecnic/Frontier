import { CONFIG } from '../shared/config.ts';
import { boxAround, cellRange, cellsPerDegree } from '../shared/grid.ts';
import type { BoardKey, BoardResult, BoardRow } from '../shared/types.ts';
import { q, q1, type Db } from './db.ts';
import { bad } from './http.ts';

const premiumCents = () => CONFIG.STORE_PRICE_PREMIUM * 100;

/** Each board ranks users by one value (cents, or a count for parcels). */
const BOARD_SQL: Record<BoardKey, () => string> = {
  money: () => 'SELECT id AS user_id, cash_cents AS value FROM users WHERE deleted_at IS NULL',
  parcels: () => 'SELECT owner_id AS user_id, count(*) AS value FROM parcels GROUP BY owner_id',
  expensive: () =>
    `SELECT owner_id AS user_id, max(max_price_cents + CASE WHEN has_store THEN ${premiumCents()} ELSE 0 END) AS value
       FROM parcels GROUP BY owner_id`,
  land_value: () =>
    `SELECT owner_id AS user_id, sum(max_price_cents + CASE WHEN has_store THEN ${premiumCents()} ELSE 0 END) AS value
       FROM parcels GROUP BY owner_id`,
  shop_keep: () =>
    `SELECT user_id, sum(amount_cents) AS value FROM ledger
      WHERE type IN ('store_proceeds', 'business_rent') GROUP BY user_id`,
  spectral_thief: () =>
    `SELECT user_id, sum(amount_cents) AS value FROM ledger WHERE type = 'spook_stolen' GROUP BY user_id`,
};

export const BOARD_KEYS = Object.keys(BOARD_SQL) as BoardKey[];

/** Nightly snapshot of all six boards (global scope; local is a filter over it). Idempotent per date. */
export async function buildLeaderboards(db: Db, date: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  await db.query('DELETE FROM leaderboards WHERE date = $1', [date]);
  for (const key of BOARD_KEYS) {
    const r = await db.query(
      `INSERT INTO leaderboards (date, board, scope, rank, user_id, value)
       SELECT $1, $2, 'global', row_number() OVER (ORDER BY b.value DESC, b.user_id), b.user_id, b.value
         FROM (${BOARD_SQL[key]()}) b JOIN users u ON u.id = b.user_id
        WHERE u.deleted_at IS NULL AND b.value > 0
        ORDER BY b.value DESC, b.user_id
        LIMIT 100000`,
      [date, key],
    );
    out[key] = r.rowCount ?? 0;
  }
  await db.query("DELETE FROM leaderboards WHERE date < $1::date - interval '30 days'", [date]);
  return out;
}

/** Users owning at least one parcel within LOCAL_BOARD_KM of a point. */
async function localUserIds(db: Db, lat: number, lng: number): Promise<number[]> {
  const km = CONFIG.LOCAL_BOARD_KM;
  const r = cellRange(boxAround(lat, lng, km));
  const cpd = cellsPerDegree();
  const rows = await q<{ owner_id: number }>(
    db,
    `SELECT DISTINCT owner_id FROM parcels
      WHERE gx BETWEEN $1 AND $2 AND gy BETWEEN $3 AND $4
        AND power(((gy + 0.5) / $5 - $6) * 111.32, 2)
          + power(((gx + 0.5) / $5 - $7) * 111.32 * cos(radians($6)), 2) <= $8`,
    [r.gx0, r.gx1, r.gy0, r.gy1, cpd, lat, lng, km * km],
  );
  return rows.map((x) => x.owner_id);
}

export async function getBoard(
  db: Db,
  board: string,
  scope: string,
  viewerId: number | null,
  where: { lat: number; lng: number } | null,
): Promise<BoardResult> {
  if (!BOARD_KEYS.includes(board as BoardKey)) throw bad('invalid_board', 'Unknown leaderboard.');
  const key = board as BoardKey;
  const sc = scope === 'local' ? 'local' : 'global';
  const latest = await q1<{ date: string }>(
    db,
    "SELECT to_char(max(date), 'YYYY-MM-DD') AS date FROM leaderboards WHERE board = $1",
    [key],
  );
  const date = latest?.date ?? null;
  if (!date) return { board: key, scope: sc, date: null, rows: [], me: null };

  type Raw = { rank: number; user_id: number; username: string; value: number };
  let ranked: BoardRow[];
  let meRow: BoardRow | null = null;
  if (sc === 'global') {
    const rows = await q<Raw>(
      db,
      `SELECT l.rank, l.user_id, u.username, l.value FROM leaderboards l JOIN users u ON u.id = l.user_id
        WHERE l.date = $1 AND l.board = $2 AND l.scope = 'global' ORDER BY l.rank LIMIT $3`,
      [date, key, CONFIG.BOARD_SIZE],
    );
    ranked = rows.map((r) => ({ rank: r.rank, userId: r.user_id, username: r.username, value: r.value }));
    if (viewerId) {
      const m = await q1<Raw>(
        db,
        `SELECT l.rank, l.user_id, u.username, l.value FROM leaderboards l JOIN users u ON u.id = l.user_id
          WHERE l.date = $1 AND l.board = $2 AND l.scope = 'global' AND l.user_id = $3`,
        [date, key, viewerId],
      );
      if (m) meRow = { rank: m.rank, userId: m.user_id, username: m.username, value: m.value };
    }
  } else {
    if (!where) return { board: key, scope: sc, date, rows: [], me: null };
    const ids = await localUserIds(db, where.lat, where.lng);
    const rows = await q<Raw>(
      db,
      `SELECT l.rank, l.user_id, u.username, l.value FROM leaderboards l JOIN users u ON u.id = l.user_id
        WHERE l.date = $1 AND l.board = $2 AND l.scope = 'global' AND l.user_id = ANY($3::bigint[])
        ORDER BY l.rank`,
      [date, key, ids],
    );
    const all = rows.map((r, i) => ({ rank: i + 1, userId: r.user_id, username: r.username, value: r.value }));
    ranked = all.slice(0, CONFIG.BOARD_SIZE);
    meRow = viewerId ? all.find((r) => r.userId === viewerId) ?? null : null;
  }
  return { board: key, scope: sc, date, rows: ranked, me: meRow };
}
