import { CONFIG } from '../shared/config.ts';
import { parseParcelId } from '../shared/grid.ts';
import { itemPrice } from '../shared/pricing.ts';
import { tx } from './db.ts';
import { credit, debit, lockUser, lockUsers, type ParcelRow } from './economy.ts';
import { HttpError, bad, conflict, forbidden, notFound } from './http.ts';
import { standingIn } from './location.ts';
import { buildMe } from './me.ts';
import { claimIdempotency, storeIdempotency } from './parcels.ts';

export type Item = 'lawyer' | 'permit' | 'spook' | 'flare';
const ITEMS: Item[] = ['lawyer', 'permit', 'spook', 'flare'];
const COLUMN: Record<Item, string> = { lawyer: 'lawyers', permit: 'permits', spook: 'spooks', flare: 'flares' };
const LABEL: Record<Item, string> = { lawyer: 'Lawyer', permit: 'Building Permit', spook: 'Spook', flare: 'Flare' };

export interface ShopRequest {
  item: Item;
  qty: number;
  place: 'office' | 'store';
  parcelId: string | null;
  idempotencyKey: string | null;
}

export function parseShopRequest(body: any, idempotencyKey: string | null): ShopRequest {
  const item = body?.item as Item;
  if (!ITEMS.includes(item)) throw bad('invalid_item', 'Unknown item.');
  const qty = Number(body?.qty ?? 1);
  if (!Number.isInteger(qty) || qty < 1 || qty > 10) throw bad('invalid_qty', 'Quantity must be 1-10.');
  const place = body?.place === 'store' ? 'store' : 'office';
  const parcelId = place === 'store' ? String(body?.parcelId ?? '') : null;
  return { item, qty, place, parcelId, idempotencyKey };
}

function capFor(item: Item): number {
  if (item === 'spook') return CONFIG.MAX_SPOOKS;
  if (item === 'flare') return CONFIG.MAX_FLARES;
  return Infinity;
}

/**
 * POST /shop/buy. The Land Office (any time, anywhere) sells Lawyers, permits,
 * and Spooks/Flares at double price. A store sells Spooks and Flares to anyone
 * standing in its parcel; its owner gets half of every sale to another player
 * and pays half price themselves.
 */
export async function shopBuy(userId: number, r: ShopRequest, at: number) {
  return tx(async (c) => {
    const replay = await claimIdempotency(c, userId, r.idempotencyKey, at);
    if (replay) return replay;

    let ownerId: number | null = null;
    let user;
    if (r.place === 'store') {
      const cell = r.parcelId ? parseParcelId(r.parcelId) : null;
      if (!cell) throw notFound('No such store');
      const p = (await c.query<ParcelRow>('SELECT * FROM parcels WHERE id = $1 FOR UPDATE', [r.parcelId])).rows[0];
      if (!p || !p.has_store) throw notFound('There is no store on that parcel.');
      ownerId = p.owner_id;
      const users = await lockUsers(c, [userId, ownerId]);
      user = users.get(userId);
      if (!user) throw new HttpError(401, 'no_user', 'Account not found.');
      if (!standingIn(user, cell.gy, cell.gx, at)) throw forbidden('not_here', 'Stand inside the store parcel to shop there.');
    } else {
      user = await lockUser(c, userId);
    }

    const isOwner = ownerId === userId;
    const unit = itemPrice(r.item, r.place, isOwner);
    if (unit == null) throw bad('not_sold_here', `Stores don't sell ${LABEL[r.item]}s; try the Land Office.`);
    const have = (user as any)[COLUMN[r.item]] as number;
    const cap = capFor(r.item);
    if (have + r.qty > cap)
      throw conflict('carry_limit', `You can carry at most ${cap} ${LABEL[r.item]}s (you have ${have}).`);
    const totalCents = unit * 100 * r.qty;
    if (user.cash_cents < totalCents)
      throw conflict('insufficient_funds', `That costs $${(totalCents / 100).toLocaleString()}.`);

    const where = r.place === 'store' ? `store ${r.parcelId}` : 'Land Office';
    await debit(c, userId, totalCents, 'item', at, {
      parcelId: r.parcelId,
      otherUserId: ownerId && !isOwner ? ownerId : null,
      note: `${r.qty} × ${LABEL[r.item]} at ${where}`,
    });
    await c.query(`UPDATE users SET ${COLUMN[r.item]} = ${COLUMN[r.item]} + $2 WHERE id = $1`, [userId, r.qty]);

    let ownerCents = 0;
    if (ownerId && !isOwner && !user.frozen) {
      ownerCents = Math.round(totalCents * CONFIG.STORE_OWNER_SHARE);
      await credit(c, ownerId, ownerCents, 'store_proceeds', at, {
        parcelId: r.parcelId,
        otherUserId: userId,
        note: `${r.qty} × ${LABEL[r.item]}`,
      });
    }
    const result = { me: await buildMe(c, userId, at), item: r.item, qty: r.qty, paidCents: totalCents, ownerCents };
    await storeIdempotency(c, userId, r.idempotencyKey, result);
    return result;
  });
}
