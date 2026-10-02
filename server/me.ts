import type { Db } from './db.ts';
import { q, q1 } from './db.ts';
import { CONFIG, HOUR_MS } from '../shared/config.ts';
import { effectiveMaxPrice, hourlyBusinessRentCents, hourlyLandRentCents } from '../shared/pricing.ts';
import type { Me, Summary } from '../shared/types.ts';
import { priceState, type ParcelRow, type UserRow } from './economy.ts';
import { HttpError } from './http.ts';

export async function buildMe(db: Db, userId: number, at: number): Promise<Me> {
  const u = await q1<UserRow>(db, 'SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL', [userId]);
  if (!u) throw new HttpError(401, 'no_user', 'Account not found.');
  const parcels = await q<ParcelRow>(
    db,
    'SELECT max_price_cents, last_visit_at, has_store FROM parcels WHERE owner_id = $1',
    [userId],
  );
  let landValue = 0;
  let hourly = 0;
  for (const p of parcels) {
    const ps = priceState(p);
    landValue += effectiveMaxPrice(ps);
    hourly += hourlyLandRentCents(ps, at) + hourlyBusinessRentCents(ps);
  }
  const inSalaryWindow = at < u.last_open_at.getTime() + CONFIG.SALARY_WINDOW_HOURS * HOUR_MS;
  if (inSalaryWindow) hourly += CONFIG.SALARY_CENTS_PER_HOUR;
  const extra = await q1<{ passkeys: number; pushes: number }>(
    db,
    `SELECT (SELECT count(*) FROM passkeys WHERE user_id = $1) AS passkeys,
            (SELECT count(*) FROM push_subscriptions WHERE user_id = $1) AS pushes`,
    [userId],
  );
  return {
    id: u.id,
    username: u.username,
    email: u.email ?? '',
    cashCents: u.cash_cents,
    inventory: { lawyers: u.lawyers, permits: u.permits, spooks: u.spooks, flares: u.flares },
    isAdmin: u.is_admin,
    frozen: u.frozen,
    parcelsOwned: parcels.length,
    landValue,
    hourlyIncomeCents: hourly,
    lastFix:
      u.last_fix_at && u.last_fix_lat != null && u.last_fix_lng != null
        ? { lat: u.last_fix_lat, lng: u.last_fix_lng, at: u.last_fix_at.toISOString(), accuracy: u.last_fix_acc ?? 0 }
        : null,
    createdAt: u.created_at.toISOString(),
    hasPasskey: (extra?.passkeys ?? 0) > 0,
    pushDevices: extra?.pushes ?? 0,
  };
}

/** Everything that happened to the player since the start of this login, the way the original login screen showed it. */
export async function buildSummary(db: Db, userId: number, since: Date): Promise<Summary> {
  const sums = await q<{ type: string; total: number }>(
    db,
    `SELECT type, sum(amount_cents) AS total FROM ledger
      WHERE user_id = $1 AND time >= $2 AND type IN ('salary','rent','business_rent','store_proceeds','spook_stolen','prize')
      GROUP BY type`,
    [userId, since],
  );
  const by = (t: string) => sums.find((s) => s.type === t)?.total ?? 0;
  const lost = await q1<{ n: number; value: number; spooks: number; sold: number }>(
    db,
    `SELECT count(*) AS n, coalesce(sum(price_cents), 0) AS value,
            count(*) FILTER (WHERE spook IN ('flared', 'fizzled')) AS spooks,
            coalesce(sum(seller_cents), 0) AS sold
       FROM deeds WHERE from_user = $1 AND time >= $2 AND kind = 'sale'`,
    [userId, since],
  );
  const salary = by('salary');
  const rent = by('rent');
  const store = by('store_proceeds') + by('business_rent');
  const stolen = by('spook_stolen');
  const prize = by('prize');
  return {
    since: since.toISOString(),
    salaryCents: salary,
    rentCents: rent,
    storeProceedsCents: store,
    stolenCents: stolen,
    prizeCents: prize,
    totalIncomeCents: salary + rent + store + stolen + prize,
    parcelsLost: lost?.n ?? 0,
    landLostCents: lost?.value ?? 0,
    spooksLost: lost?.spooks ?? 0,
  };
}
