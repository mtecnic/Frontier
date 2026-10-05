import type pg from 'pg';
import { CONFIG, HOUR_MS, MINUTE_MS } from '../shared/config.ts';
import { settleRent, settleSalary, type PriceState } from '../shared/pricing.ts';
import { HttpError } from './http.ts';

export interface UserRow {
  id: number;
  username: string;
  email: string | null;
  cash_cents: number;
  lawyers: number;
  permits: number;
  spooks: number;
  flares: number;
  created_at: Date;
  last_open_at: Date;
  salary_settled_at: Date;
  income_settled_at: Date;
  summary_from: Date;
  last_fix_lat: number | null;
  last_fix_lng: number | null;
  last_fix_at: Date | null;
  last_fix_acc: number | null;
  last_purchase_at: Date | null;
  is_admin: boolean;
  frozen: boolean;
  deleted_at: Date | null;
}

export interface ParcelRow {
  id: string;
  gy: number;
  gx: number;
  owner_id: number;
  price_paid_cents: number;
  max_price_cents: number;
  last_visit_at: Date;
  purchased_at: Date;
  locked_until: Date;
  rent_settled_at: Date;
  has_spook: boolean;
  has_store: boolean;
  store_built_at: Date | null;
}

export type LedgerType =
  | 'start'
  | 'salary'
  | 'rent'
  | 'business_rent'
  | 'purchase'
  | 'sale'
  | 'spook_paid'
  | 'spook_stolen'
  | 'item'
  | 'store_proceeds'
  | 'prize'
  | 'admin';

export function priceState(p: Pick<ParcelRow, 'max_price_cents' | 'last_visit_at' | 'has_store'>): PriceState {
  return { maxPrice: Math.round(p.max_price_cents / 100), lastVisitAt: p.last_visit_at.getTime(), hasStore: p.has_store };
}

/**
 * Move money in or out of a user's cash and write the matching ledger row.
 * Callers must hold the user's row lock. Debits that would go negative throw 409.
 */
export async function moveMoney(
  c: pg.PoolClient,
  userId: number,
  amountCents: number,
  type: LedgerType,
  at: number,
  opts: { parcelId?: string | null; otherUserId?: number | null; note?: string | null } = {},
): Promise<void> {
  if (!Number.isInteger(amountCents)) throw new Error(`non-integer cents: ${amountCents}`);
  if (amountCents === 0) return;
  try {
    await c.query('UPDATE users SET cash_cents = cash_cents + $2 WHERE id = $1', [userId, amountCents]);
  } catch (err: any) {
    if (err?.code === '23514') throw new HttpError(409, 'insufficient_funds', "You don't have enough cash for that.");
    throw err;
  }
  await c.query(
    `INSERT INTO ledger (user_id, time, type, amount_cents, parcel_id, other_user_id, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [userId, new Date(at), type, amountCents, opts.parcelId ?? null, opts.otherUserId ?? null, opts.note ?? null],
  );
}

export async function lockUser(c: pg.PoolClient, userId: number): Promise<UserRow> {
  const r = await c.query<UserRow>('SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [userId]);
  if (!r.rows[0]) throw new HttpError(401, 'no_user', 'Account not found.');
  return r.rows[0];
}

/** Lock several users in id order (deadlock-safe). */
export async function lockUsers(c: pg.PoolClient, ids: number[]): Promise<Map<number, UserRow>> {
  const uniq = [...new Set(ids)].sort((a, b) => a - b);
  const r = await c.query<UserRow>('SELECT * FROM users WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE', [uniq]);
  return new Map(r.rows.map((u) => [u.id, u]));
}

export interface RentTotals {
  landCents: number;
  businessCents: number;
}

/**
 * Pay the owner the rent banked on these (already locked) parcels up to `now`.
 * Advances rent_settled_at on each parcel row (and on the passed objects).
 */
export async function settleParcels(
  c: pg.PoolClient,
  ownerId: number,
  parcels: ParcelRow[],
  now: number,
  ledgerParcelId: string | null = null,
  prorate = false,
): Promise<RentTotals> {
  const ids: string[] = [];
  const times: Date[] = [];
  let landCents = 0;
  let businessCents = 0;
  for (const p of parcels) {
    if (p.owner_id !== ownerId) continue;
    const r = settleRent(priceState(p), p.rent_settled_at.getTime(), now, prorate);
    if (r.settledAt === p.rent_settled_at.getTime()) continue;
    landCents += r.landCents;
    businessCents += r.businessCents;
    ids.push(p.id);
    const t = new Date(r.settledAt);
    times.push(t);
    p.rent_settled_at = t;
  }
  if (ids.length) {
    await c.query(
      `UPDATE parcels SET rent_settled_at = v.t
         FROM (SELECT unnest($1::text[]) AS id, unnest($2::timestamptz[]) AS t) v
        WHERE parcels.id = v.id`,
      [ids, times],
    );
  }
  await moveMoney(c, ownerId, landCents, 'rent', now, { parcelId: ledgerParcelId });
  await moveMoney(c, ownerId, businessCents, 'business_rent', now, { parcelId: ledgerParcelId });
  return { landCents, businessCents };
}

export interface IncomeResult {
  user: UserRow;
  salaryCents: number;
  rentCents: number;
  businessCents: number;
  newLogin: boolean;
  /** Parcels locked by this settlement (owned ones needing rent, plus the extra id if it exists). */
  locked: Map<string, ParcelRow>;
}

/**
 * Lazy income settlement (no hourly job): salary for eligible hours, then rent on
 * every owned parcel for each whole hour since it was last settled (max 72).
 *
 * Lock order everywhere in the server is parcels (by id) before users (by id).
 * `extraParcelId` lets the caller lock one more parcel in the same statement
 * (the cell the player is standing in, for owner visits).
 */
export async function settleIncome(
  c: pg.PoolClient,
  userId: number,
  now: number,
  opts: { open: boolean; extraParcelId?: string | null },
): Promise<IncomeResult> {
  const dueBefore = new Date(now - HOUR_MS);
  const pr = await c.query<ParcelRow>(
    `SELECT * FROM parcels
      WHERE (owner_id = $1 AND rent_settled_at <= $2) OR id = $3
      ORDER BY id FOR UPDATE`,
    [userId, dueBefore, opts.extraParcelId ?? null],
  );
  const locked = new Map(pr.rows.map((p) => [p.id, p]));
  const user = await lockUser(c, userId);

  const rent = await settleParcels(
    c,
    userId,
    pr.rows.filter((p) => p.owner_id === userId),
    now,
  );

  const sal = settleSalary(
    { lastOpenAt: user.last_open_at.getTime(), salarySettledAt: user.salary_settled_at.getTime() },
    now,
    opts.open,
  );
  await moveMoney(c, userId, sal.cents, 'salary', now);

  const newLogin = opts.open && now - user.last_open_at.getTime() > CONFIG.LOGIN_GAP_MINUTES * MINUTE_MS;
  const summaryFrom = newLogin ? user.last_open_at : user.summary_from;
  const r = await c.query<UserRow>(
    `UPDATE users SET last_open_at = $2, salary_settled_at = $3, income_settled_at = $4, summary_from = $5
      WHERE id = $1 RETURNING *`,
    [userId, new Date(sal.lastOpenAt), new Date(sal.salarySettledAt), new Date(now), summaryFrom],
  );
  return {
    user: r.rows[0]!,
    salaryCents: sal.cents,
    rentCents: rent.landCents,
    businessCents: rent.businessCents,
    newLogin,
    locked,
  };
}

export async function credit(
  c: pg.PoolClient,
  userId: number,
  amountCents: number,
  type: LedgerType,
  at: number,
  opts?: { parcelId?: string | null; otherUserId?: number | null; note?: string | null },
) {
  if (amountCents < 0) throw new Error('credit must be positive');
  await moveMoney(c, userId, amountCents, type, at, opts);
}

export async function debit(
  c: pg.PoolClient,
  userId: number,
  amountCents: number,
  type: LedgerType,
  at: number,
  opts?: { parcelId?: string | null; otherUserId?: number | null; note?: string | null },
) {
  if (amountCents < 0) throw new Error('debit must be positive');
  await moveMoney(c, userId, -amountCents, type, at, opts);
}
