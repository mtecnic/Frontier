import type pg from 'pg';
import { CONFIG, DAY_MS, HOUR_MS } from '../shared/config.ts';
import { cellCenter, cellRange, haversineKm, parseParcelId, type Bounds } from '../shared/grid.ts';
import {
  currentPrice,
  effectiveMaxPrice,
  formatDollars,
  hourlyBusinessRentCents,
  hourlyLandRentCents,
  nextMaxPrice,
  sellerShareCents,
  spookTakeCents,
} from '../shared/pricing.ts';
import type { BuyResult, ParcelDetail, ParcelView, PrizeView, PromotionView } from '../shared/types.ts';
import { pool, q, q1, tx, type Db } from './db.ts';
import { credit, debit, lockUser, lockUsers, priceState, settleParcels, type ParcelRow, type UserRow } from './economy.ts';
import { HttpError, bad, conflict, forbidden, notFound } from './http.ts';
import { standingIn } from './location.ts';
import { buildMe } from './me.ts';
import { notifyUser } from './push.ts';
import { raiseFlag } from './flags.ts';
import { promotionsNear, prizesNear } from './nearby.ts';

type ParcelWithOwner = ParcelRow & { owner_name: string | null };

export function parcelView(p: ParcelWithOwner, at: number): ParcelView {
  const ps = priceState(p);
  return {
    id: p.id,
    gy: p.gy,
    gx: p.gx,
    ownerId: p.owner_id,
    owner: p.owner_name,
    price: currentPrice(ps, at),
    maxPrice: effectiveMaxPrice(ps),
    spook: p.has_spook,
    store: p.has_store,
    lockedUntil: p.locked_until.getTime() > at ? p.locked_until.toISOString() : null,
  };
}

export function parseBbox(raw: string | null): Bounds {
  const parts = (raw ?? '').split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) throw bad('invalid_bbox', 'bbox=west,south,east,north');
  const [west, south, east, north] = parts as [number, number, number, number];
  if (south < -90 || north > 90 || south > north) throw bad('invalid_bbox', 'bbox latitude out of range');
  return { west: Math.max(-180, west), south, east: Math.min(180, east), north };
}

const BBOX_LIMIT = 5000;

/** GET /parcels?bbox= : owned parcels, Spooks, stores and visible prizes in the viewport. */
export async function parcelsInBox(b: Bounds, viewer: UserRow | null, at: number) {
  const r = cellRange(b);
  const rows = await q<ParcelWithOwner>(
    pool,
    `SELECT p.*, u.username AS owner_name FROM parcels p JOIN users u ON u.id = p.owner_id
      WHERE p.gx BETWEEN $1 AND $2 AND p.gy BETWEEN $3 AND $4
      ORDER BY (p.owner_id = $5) DESC, p.max_price_cents DESC
      LIMIT $6`,
    [r.gx0, r.gx1, r.gy0, r.gy1, viewer?.id ?? 0, BBOX_LIMIT + 1],
  );
  const truncated = rows.length > BBOX_LIMIT;
  let prizes: PrizeView[] = [];
  let promotions: PromotionView[] = [];
  if (viewer?.last_fix_lat != null && viewer.last_fix_lng != null) {
    prizes = await prizesNear(pool, viewer.last_fix_lat, viewer.last_fix_lng, at);
    promotions = await promotionsNear(pool, viewer.last_fix_lat, viewer.last_fix_lng, at);
  }
  return {
    parcels: rows.slice(0, BBOX_LIMIT).map((p) => parcelView(p, at)),
    truncated,
    prizes,
    promotions,
    serverTime: new Date(at).toISOString(),
  };
}

export async function parcelDetail(db: Db, id: string, viewer: UserRow | null, at: number): Promise<ParcelDetail> {
  const cell = parseParcelId(id);
  if (!cell) throw notFound('No such parcel');
  const p = await q1<ParcelWithOwner>(
    db,
    'SELECT p.*, u.username AS owner_name FROM parcels p JOIN users u ON u.id = p.owner_id WHERE p.id = $1',
    [id],
  );
  const history = await q<{ time: Date; from_name: string | null; to_name: string | null; price_cents: number; via_lawyer: boolean }>(
    db,
    `SELECT d.time, f.username AS from_name, t.username AS to_name, d.price_cents, d.via_lawyer
       FROM deeds d LEFT JOIN users f ON f.id = d.from_user LEFT JOIN users t ON t.id = d.to_user
      WHERE d.parcel_id = $1 AND d.kind = 'sale' ORDER BY d.time DESC LIMIT 8`,
    [id],
  );
  let prize = false;
  if (viewer?.last_fix_lat != null && viewer.last_fix_lng != null) {
    const c = cellCenter(cell.gy, cell.gx);
    if (haversineKm(viewer.last_fix_lat, viewer.last_fix_lng, c.lat, c.lng) <= CONFIG.PRIZE_VISIBLE_KM) {
      prize = !!(await q1(
        db,
        'SELECT 1 FROM prizes WHERE gx = $1 AND gy = $2 AND claimed_by IS NULL AND expires_at > $3',
        [cell.gx, cell.gy, new Date(at)],
      ));
    }
  }
  const promotions = (
    await q<{ id: number; parcel_id: string; gy: number; gx: number; business: string; title: string; body: string; url: string | null; ends_at: Date | null }>(
      db,
      `SELECT * FROM promotions WHERE parcel_id = $1 AND active
          AND (starts_at IS NULL OR starts_at <= $2) AND (ends_at IS NULL OR ends_at > $2)`,
      [id, new Date(at)],
    )
  ).map((r) => ({
    id: r.id,
    parcelId: r.parcel_id,
    gy: r.gy,
    gx: r.gx,
    business: r.business,
    title: r.title,
    body: r.body,
    url: r.url,
    endsAt: r.ends_at?.toISOString() ?? null,
  }));
  const hist = history.map((h) => ({
    time: h.time.toISOString(),
    from: h.from_name,
    to: h.to_name,
    price: Math.round(h.price_cents / 100),
    viaLawyer: h.via_lawyer,
  }));
  if (!p) {
    return {
      id,
      gy: cell.gy,
      gx: cell.gx,
      ownerId: null,
      owner: null,
      price: currentPrice(null, at),
      maxPrice: currentPrice(null, at),
      spook: false,
      store: false,
      lockedUntil: null,
      pricePaid: null,
      purchasedAt: null,
      lastVisitAt: null,
      hourlyRentCents: 0,
      businessRentCents: 0,
      locked: false,
      prize,
      promotions,
      history: hist,
    };
  }
  const ps = priceState(p);
  return {
    ...parcelView(p, at),
    pricePaid: Math.round(p.price_paid_cents / 100),
    purchasedAt: p.purchased_at.toISOString(),
    lastVisitAt: p.last_visit_at.toISOString(),
    hourlyRentCents: hourlyLandRentCents(ps, at),
    businessRentCents: hourlyBusinessRentCents(ps),
    locked: p.locked_until.getTime() > at,
    prize,
    promotions,
    history: hist,
  };
}

// ---- Idempotency --------------------------------------------------------------

/**
 * Claim an idempotency key inside the transaction. Returns the stored response
 * if this request was already completed, so a retry never charges twice.
 */
export async function claimIdempotency(c: pg.PoolClient, userId: number, key: string | null, at: number): Promise<unknown | null> {
  if (!key) return null;
  if (key.length > 200) throw bad('invalid_idempotency_key', 'Idempotency-Key is too long');
  const ins = await c.query(
    'INSERT INTO idempotency (user_id, key, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [userId, key, new Date(at)],
  );
  if (ins.rowCount) return null;
  const prev = await c.query<{ response: unknown }>('SELECT response FROM idempotency WHERE user_id = $1 AND key = $2', [
    userId,
    key,
  ]);
  if (prev.rows[0]?.response) return prev.rows[0].response;
  throw new HttpError(409, 'in_progress', 'That request is already being processed.');
}

export async function storeIdempotency(c: pg.PoolClient, userId: number, key: string | null, response: unknown) {
  if (!key) return;
  await c.query('UPDATE idempotency SET status = 200, response = $3 WHERE user_id = $1 AND key = $2', [
    userId,
    key,
    JSON.stringify(response),
  ]);
}

async function lockParcel(c: pg.PoolClient, id: string): Promise<ParcelRow | null> {
  // The advisory lock also serialises buyers of land that has no row yet.
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 7))', [`parcel:${id}`]);
  const r = await c.query<ParcelRow>('SELECT * FROM parcels WHERE id = $1 FOR UPDATE', [id]);
  return r.rows[0] ?? null;
}

// ---- Purchase ---------------------------------------------------------------

export interface BuyOptions {
  useFlare: boolean;
  useLawyer: boolean;
  /** Refuse if the price has risen above what the player saw. */
  maxPrice: number | null;
  idempotencyKey: string | null;
}

interface PushJob {
  userId: number;
  title: string;
  body: string;
  url: string;
  tag: string;
}

/**
 * One purchase, one transaction, in the order the spec lays out:
 * 1 location (or Lawyer)  2 lock  3 settle seller rent  4 charge / pay 80%
 * 5 Spook  6 transfer (+store, new max, 24h lock)  7 push the seller.
 */
export async function buyParcel(buyerId: number, id: string, opts: BuyOptions, at: number): Promise<BuyResult> {
  const cell = parseParcelId(id);
  if (!cell) throw notFound('No such parcel');

  const { result, push, replayed } = await tx(async (c) => {
    const replay = await claimIdempotency(c, buyerId, opts.idempotencyKey, at);
    if (replay) return { result: replay as BuyResult, push: null, replayed: true };

    const parcel = await lockParcel(c, id);
    const sellerId = parcel?.owner_id ?? null;
    const users = await lockUsers(c, sellerId ? [buyerId, sellerId] : [buyerId]);
    const buyer = users.get(buyerId);
    if (!buyer || buyer.deleted_at) throw new HttpError(401, 'no_user', 'Account not found.');
    const seller = sellerId ? users.get(sellerId) ?? null : null;

    if (sellerId === buyerId) throw conflict('own_parcel', 'You already own this parcel. Visiting it keeps its price at max.');

    // 1. Location, or a Lawyer.
    if (opts.useLawyer) {
      if (buyer.lawyers < 1) throw conflict('no_lawyer', 'You have no Lawyers. The Land Office sells them.');
      if (buyer.last_fix_lat == null || buyer.last_fix_lng == null)
        throw conflict('no_fix', 'A Lawyer works within range of your last verified location, and you have none yet.');
      const c0 = cellCenter(cell.gy, cell.gx);
      const km = haversineKm(buyer.last_fix_lat, buyer.last_fix_lng, c0.lat, c0.lng);
      if (km > CONFIG.LAWYER_RANGE_KM)
        throw conflict(
          'out_of_range',
          `That parcel is ${km.toFixed(1)} km from your last verified location; Lawyers reach ${CONFIG.LAWYER_RANGE_KM} km.`,
        );
    } else if (!standingIn(buyer, cell.gy, cell.gx, at)) {
      throw forbidden('not_here', 'You need a fresh, verified GPS fix inside this parcel to buy it (or use a Lawyer).');
    }

    // 2. Lock.
    if (parcel && parcel.locked_until.getTime() > at)
      throw conflict('locked', 'This parcel changed hands recently and is locked.', {
        lockedUntil: parcel.locked_until.toISOString(),
      });
    if (buyer.last_purchase_at && at - buyer.last_purchase_at.getTime() < CONFIG.PURCHASE_COOLDOWN_S * 1000)
      throw new HttpError(429, 'too_fast', 'Easy there. One purchase every few seconds.');
    if (buyer.frozen && seller)
      throw forbidden('under_review', 'Your account is under review, so you can only buy unowned land for now.');

    // 3. Settle the seller's accrued rent on this parcel up to this moment.
    if (parcel && seller) await settleParcels(c, seller.id, [parcel], at, parcel.id);

    // 4. Charge the buyer the current price; credit the seller their share.
    const ps = parcel ? priceState(parcel) : null;
    const price = currentPrice(ps, at);
    if (opts.maxPrice != null && price > opts.maxPrice)
      throw conflict('price_changed', `The price is now $${price}.`, { price });
    if (buyer.cash_cents < price * 100)
      throw conflict('insufficient_funds', `This parcel costs $${price} and you have ${formatDollars(buyer.cash_cents)}.`, {
        price,
      });
    await debit(c, buyerId, price * 100, 'purchase', at, { parcelId: id, otherUserId: sellerId });
    let sellerCents = 0;
    if (seller) {
      sellerCents = sellerShareCents(price);
      await credit(c, seller.id, sellerCents, 'sale', at, { parcelId: id, otherUserId: buyerId });
    }

    // 5. Resolve the Spook.
    let spook: BuyResult['spook'] = null;
    let flareUsed = 0;
    if (parcel?.has_spook) {
      if (!opts.useLawyer && opts.useFlare && buyer.flares > 0) {
        flareUsed = 1;
        spook = { outcome: 'flared', takenCents: 0 };
      } else if (!seller || seller.frozen) {
        spook = { outcome: 'fizzled', takenCents: 0 };
      } else {
        const take = spookTakeCents(price, buyer.cash_cents - price * 100);
        await debit(c, buyerId, take, 'spook_paid', at, { parcelId: id, otherUserId: seller.id });
        await credit(c, seller.id, take, 'spook_stolen', at, { parcelId: id, otherUserId: buyerId });
        spook = { outcome: 'triggered', takenCents: take };
      }
    }

    // 6. Transfer the parcel (and any store on it), new max, price back to max, 24h lock.
    const hasStore = parcel?.has_store ?? false;
    const newMax = nextMaxPrice(price, hasStore);
    const lockUntil = new Date(at + CONFIG.PURCHASE_LOCK_HOURS * HOUR_MS);
    const t = new Date(at);
    await c.query(
      `INSERT INTO parcels (id, gy, gx, owner_id, price_paid_cents, max_price_cents, last_visit_at, purchased_at,
                            locked_until, rent_settled_at, has_spook, has_store)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $7, false, false)
       ON CONFLICT (id) DO UPDATE SET owner_id = EXCLUDED.owner_id, price_paid_cents = EXCLUDED.price_paid_cents,
         max_price_cents = EXCLUDED.max_price_cents, last_visit_at = EXCLUDED.last_visit_at,
         purchased_at = EXCLUDED.purchased_at, locked_until = EXCLUDED.locked_until,
         rent_settled_at = EXCLUDED.rent_settled_at, has_spook = false`,
      [id, cell.gy, cell.gx, buyerId, price * 100, newMax * 100, t, lockUntil],
    );
    await c.query(
      `INSERT INTO deeds (parcel_id, time, from_user, to_user, price_cents, seller_cents, via_lawyer, spook, spook_cents, had_store)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, t, sellerId, buyerId, price * 100, sellerCents, opts.useLawyer, spook?.outcome ?? null, spook?.takenCents ?? 0, hasStore],
    );
    await c.query(
      'UPDATE users SET lawyers = lawyers - $2, flares = flares - $3, last_purchase_at = $4 WHERE id = $1',
      [buyerId, opts.useLawyer ? 1 : 0, flareUsed, t],
    );

    const result: BuyResult = {
      parcel: await parcelDetail(c, id, buyer, at),
      me: await buildMe(c, buyerId, at),
      paid: price,
      sellerReceivedCents: sellerCents,
      seller: seller?.username ?? null,
      spook,
      viaLawyer: opts.useLawyer,
    };
    await storeIdempotency(c, buyerId, opts.idempotencyKey, result);

    // 7. Tell the seller (sent after commit).
    let push: PushJob | null = null;
    if (seller) {
      let body = `${buyer.username} bought parcel ${id}${opts.useLawyer ? ' with a Lawyer' : ''} for $${price}. You received ${formatDollars(sellerCents, true)}.`;
      if (spook?.outcome === 'triggered') body += ` Your Spook took ${formatDollars(spook.takenCents, true)} from them!`;
      if (spook?.outcome === 'flared') body += ' They used a Flare on your Spook.';
      push = { userId: seller.id, title: 'Claim jumped!', body, url: `#/parcel/${id}`, tag: `jump-${id}` };
    }
    return { result, push, replayed: false };
  });

  if (push) notifyUser(push.userId, push).catch((err) => console.warn('push error', err));
  if (!replayed) postPurchaseChecks(buyerId, at).catch((err) => console.warn('flag check failed', err));
  return result;
}

/** Flag (for review) more than FLAG_PURCHASES_PER_DAY a day, or long straight runs through the grid. */
async function postPurchaseChecks(userId: number, at: number) {
  const day = await q1<{ n: number }>(
    pool,
    "SELECT count(*) AS n FROM deeds WHERE to_user = $1 AND kind = 'sale' AND time > $2",
    [userId, new Date(at - DAY_MS)],
  );
  if ((day?.n ?? 0) > CONFIG.FLAG_PURCHASES_PER_DAY)
    await raiseFlag(pool, userId, 'purchases_per_day', { count: day!.n }, at);

  const run = CONFIG.FLAG_STRAIGHT_LINE_RUN;
  const recent = await q<{ parcel_id: string }>(
    pool,
    "SELECT parcel_id FROM deeds WHERE to_user = $1 AND kind = 'sale' ORDER BY time DESC LIMIT $2",
    [userId, run],
  );
  if (recent.length < run) return;
  const cells = recent.map((r) => parseParcelId(r.parcel_id)!).reverse();
  const dy = cells[1]!.gy - cells[0]!.gy;
  const dx = cells[1]!.gx - cells[0]!.gx;
  if (Math.abs(dy) + Math.abs(dx) !== 1) return;
  for (let i = 2; i < cells.length; i++) {
    if (cells[i]!.gy - cells[i - 1]!.gy !== dy || cells[i]!.gx - cells[i - 1]!.gx !== dx) return;
  }
  await raiseFlag(pool, userId, 'straight_line', { parcels: recent.map((r) => r.parcel_id) }, at);
}

// ---- Spooks and stores ------------------------------------------------------

export async function placeSpook(userId: number, id: string, at: number, idempotencyKey: string | null) {
  const cell = parseParcelId(id);
  if (!cell) throw notFound('No such parcel');
  return tx(async (c) => {
    const replay = await claimIdempotency(c, userId, idempotencyKey, at);
    if (replay) return replay;
    const parcel = await lockParcel(c, id);
    const user = await lockUser(c, userId);
    if (!parcel || parcel.owner_id !== userId) throw forbidden('not_owner', 'You can only spook land you own.');
    if (!standingIn(user, cell.gy, cell.gx, at)) throw forbidden('not_here', 'Stand on the parcel to place a Spook.');
    if (parcel.has_spook) throw conflict('already_spooked', 'This parcel already has a Spook.');
    if (user.spooks < 1) throw conflict('no_spook', 'You have no Spooks. Buy one at a store or the Land Office.');
    await c.query('UPDATE parcels SET has_spook = true WHERE id = $1', [id]);
    await c.query('UPDATE users SET spooks = spooks - 1 WHERE id = $1', [userId]);
    const result = { parcel: await parcelDetail(c, id, user, at), me: await buildMe(c, userId, at) };
    await storeIdempotency(c, userId, idempotencyKey, result);
    return result;
  });
}

export async function buildStore(userId: number, id: string, at: number, idempotencyKey: string | null) {
  const cell = parseParcelId(id);
  if (!cell) throw notFound('No such parcel');
  return tx(async (c) => {
    const replay = await claimIdempotency(c, userId, idempotencyKey, at);
    if (replay) return replay;
    const parcel = await lockParcel(c, id);
    const user = await lockUser(c, userId);
    if (!parcel || parcel.owner_id !== userId) throw forbidden('not_owner', 'You can only build on land you own.');
    if (!standingIn(user, cell.gy, cell.gx, at)) throw forbidden('not_here', 'Stand on the parcel to build a store.');
    if (parcel.has_store) throw conflict('already_store', 'This parcel already has a store.');
    if (user.permits < 1)
      throw conflict('no_permit', `You need a Building Permit ($${CONFIG.PERMIT_PRICE.toLocaleString()} at the Land Office).`);
    // Bank rent at the pre-store rate first.
    await settleParcels(c, userId, [parcel], at, id);
    await c.query('UPDATE parcels SET has_store = true, store_built_at = $2, last_visit_at = $2 WHERE id = $1', [
      id,
      new Date(at),
    ]);
    await c.query('UPDATE users SET permits = permits - 1 WHERE id = $1', [userId]);
    const result = { parcel: await parcelDetail(c, id, user, at), me: await buildMe(c, userId, at) };
    await storeIdempotency(c, userId, idempotencyKey, result);
    return result;
  });
}

/** Parcels the player owns, priciest first. */
export async function myParcels(userId: number, at: number) {
  const rows = await q<ParcelWithOwner>(
    pool,
    `SELECT p.*, u.username AS owner_name FROM parcels p JOIN users u ON u.id = p.owner_id
      WHERE p.owner_id = $1 ORDER BY p.has_store DESC, p.max_price_cents DESC, p.id LIMIT 2000`,
    [userId],
  );
  return rows.map((p) => {
    const ps = priceState(p);
    return {
      ...parcelView(p, at),
      lastVisitAt: p.last_visit_at.toISOString(),
      purchasedAt: p.purchased_at.toISOString(),
      hourlyRentCents: hourlyLandRentCents(ps, at) + hourlyBusinessRentCents(ps),
    };
  });
}

