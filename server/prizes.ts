import { CONFIG, DAY_MS, HOUR_MS } from '../shared/config.ts';
import { cellOf, parcelId, randomPointWithin } from '../shared/grid.ts';
import type { ClaimedPrize } from '../shared/types.ts';
import { q, type Db } from './db.ts';

export function rollPrize(rand: () => number = Math.random): { kind: 'cash' | 'lawyer'; amountCents: number } {
  if (rand() < 1 / CONFIG.PRIZE_LAWYER_ONE_IN) return { kind: 'lawyer', amountCents: 0 };
  let roll = rand();
  for (const tier of CONFIG.PRIZE_TIERS) {
    if (roll < tier.chance) {
      const dollars = tier.min + Math.floor(rand() * (tier.max - tier.min + 1));
      return { kind: 'cash', amountCents: dollars * 100 };
    }
    roll -= tier.chance;
  }
  const last = CONFIG.PRIZE_TIERS[CONFIG.PRIZE_TIERS.length - 1]!;
  return { kind: 'cash', amountCents: last.max * 100 };
}

/**
 * Nightly: PRIZES_PER_ACTIVE_PLAYER prizes per player seen in the last
 * PRIZE_ACTIVE_DAYS, on random parcels within PRIZE_SPAWN_RADIUS_KM of that
 * player's last fix. Prizes expire after PRIZE_EXPIRY_HOURS.
 */
export async function spawnPrizes(db: Db, at: number, rand: () => number = Math.random): Promise<number> {
  const players = await q<{ id: number; lat: number; lng: number }>(
    db,
    `SELECT id, last_fix_lat AS lat, last_fix_lng AS lng FROM users
      WHERE deleted_at IS NULL AND last_fix_lat IS NOT NULL AND last_open_at > $1`,
    [new Date(at - CONFIG.PRIZE_ACTIVE_DAYS * DAY_MS)],
  );
  const rows: unknown[][] = [];
  const used = new Set<string>();
  for (const p of players) {
    for (let i = 0; i < CONFIG.PRIZES_PER_ACTIVE_PLAYER; i++) {
      let id = '';
      let cell = { gy: 0, gx: 0 };
      for (let attempt = 0; attempt < 10; attempt++) {
        const pt = randomPointWithin(p.lat, p.lng, CONFIG.PRIZE_SPAWN_RADIUS_KM, rand);
        cell = cellOf(pt.lat, pt.lng);
        id = parcelId(cell.gy, cell.gx);
        if (!used.has(id)) break;
      }
      used.add(id);
      const prize = rollPrize(rand);
      rows.push([id, cell.gy, cell.gx, prize.kind, prize.amountCents, p.id]);
    }
  }
  const created = new Date(at);
  const expires = new Date(at + CONFIG.PRIZE_EXPIRY_HOURS * HOUR_MS);
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const values: unknown[] = [];
    const tuples = chunk.map((r, j) => {
      values.push(...r, created, expires);
      const b = j * 8;
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8})`;
    });
    await db.query(
      `INSERT INTO prizes (parcel_id, gy, gx, kind, amount_cents, spawned_for, created_at, expires_at) VALUES ${tuples.join(', ')}`,
      values,
    );
  }
  return rows.length;
}

/** Drop unclaimed prizes that expired more than a week ago. */
export async function pruneExpiredPrizes(db: Db, at: number): Promise<number> {
  const r = await db.query('DELETE FROM prizes WHERE claimed_by IS NULL AND expires_at < $1', [new Date(at - 7 * DAY_MS)]);
  return r.rowCount ?? 0;
}

export async function claimedPrizes(db: Db, userId: number, limit = 20): Promise<ClaimedPrize[]> {
  const rows = await q<{ id: number; parcel_id: string; kind: 'cash' | 'lawyer'; amount_cents: number; claimed_at: Date }>(
    db,
    'SELECT id, parcel_id, kind, amount_cents, claimed_at FROM prizes WHERE claimed_by = $1 ORDER BY claimed_at DESC LIMIT $2',
    [userId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    parcelId: r.parcel_id,
    kind: r.kind,
    amountCents: r.amount_cents,
    claimedAt: r.claimed_at.toISOString(),
  }));
}
