import { CONFIG } from '../../../shared/config.ts';
import { cellCenter, cellIdOf, haversineKm, parseParcelId } from '../../../shared/grid.ts';
import { itemPrice, parcelColor, spookTakeCents } from '../../../shared/pricing.ts';
import type { BuyResult, Me, ParcelDetail } from '../../../shared/types.ts';
import { api, ApiError } from '../api.ts';
import { ART } from '../art.ts';
import { freshFix, toApiFix } from '../geo.ts';
import { COLORS, revealCell, setSelected, upsertParcel } from '../map.ts';
import { on, serverNow, setMe, state } from '../state.ts';
import { actions, busy, dialog, openSheet, setSheetBody, sheetBody, toast } from '../ui.ts';
import { ago, distance, dollars, duration, html, money, moneySmart, raw, uuid, type Raw } from '../util.ts';

let current: ParcelDetail | null = null;
let currentId: string | null = null;
let unsub: (() => void)[] = [];

export function standingOn(id: string): boolean {
  const f = state.fix;
  return !!f && cellIdOf(f.lat, f.lng) === id;
}

function distanceTo(id: string): number | null {
  const f = state.fix;
  const c = parseParcelId(id);
  if (!f || !c) return null;
  const ctr = cellCenter(c.gy, c.gx);
  return haversineKm(f.lat, f.lng, ctr.lat, ctr.lng);
}

function lawyerReachKm(id: string, me: Me): number | null {
  const c = parseParcelId(id);
  if (!c || !me.lastFix) return null;
  const ctr = cellCenter(c.gy, c.gx);
  return haversineKm(me.lastFix.lat, me.lastFix.lng, ctr.lat, ctr.lng);
}

export async function showParcel(id: string) {
  const cell = parseParcelId(id);
  if (!cell) {
    toast('No such parcel.', 'bad');
    return;
  }
  currentId = id;
  setSelected(id);
  const cached = state.parcels.get(id);
  openSheet({
    title: html`Parcel <span class="mono">${id}</span>`,
    body: html`<div class="loading">${cached ? `${cached.owner ?? 'Unowned'} · ${dollars(cached.price)}` : 'Looking up the deed...'}</div>`,
    className: 'parcel-sheet',
    onClose: () => {
      currentId = null;
      current = null;
      setSelected(null);
      unsub.forEach((u) => u());
      unsub = [];
    },
  });
  unsub.push(on('fix', parcelSheetFixChanged), on('me', meChanged));
  bind(sheetBody()!);
  setTimeout(() => revealCell(id), 350);
  await load(id);
}

async function load(id: string) {
  try {
    const d = await api<ParcelDetail>('GET', `/parcels/${encodeURIComponent(id)}`);
    if (currentId !== id) return;
    current = d;
    upsertParcel(d);
    rerender();
  } catch (err) {
    setSheetBody(html`<p class="error">${(err as Error).message}</p>`);
  }
}

let lastStanding: boolean | null = null;
let flareChoice = true;
let meSig = '';

function signature(me: Me | null): string {
  return me ? JSON.stringify([me.id, me.cashCents, me.inventory, me.frozen, me.lastFix?.lat, me.lastFix?.lng]) : '';
}

function meChanged() {
  if (signature(state.me) !== meSig) rerender();
}

function rerender() {
  if (!current || current.id !== currentId) return;
  const body = sheetBody();
  if (!body) return;
  lastStanding = standingOn(current.id);
  meSig = signature(state.me);
  body.innerHTML = view(current).html;
  body.querySelector<HTMLInputElement>('#use-flare')?.addEventListener('change', (e) => {
    flareChoice = (e.target as HTMLInputElement).checked;
  });
}

function row(label: string, value: Raw | string) {
  return html`<div class="kv"><span>${label}</span><b>${value}</b></div>`;
}

function view(p: ParcelDetail): Raw {
  const me = state.me;
  const myId = me?.id ?? null;
  const mine = p.ownerId != null && p.ownerId === myId;
  const color = parcelColor(p.ownerId, myId, p.price);
  const standing = standingOn(p.id);
  const now = serverNow();
  const lockLeft = p.lockedUntil ? Date.parse(p.lockedUntil) - now : 0;
  const locked = lockLeft > 0;
  const dist = distanceTo(p.id);
  const c = cellCenter(p.gy, p.gx);

  const ownerLine = p.ownerId == null ? 'Unowned land' : mine ? 'Your land' : html`Owned by <b>${p.owner}</b>`;
  const badges: Raw[] = [];
  if (p.spook) badges.push(html`<span class="badge">${raw(ART.ghost)} Spooked</span>`);
  if (p.store) badges.push(html`<span class="badge">${raw(ART.cabin)} General store</span>`);
  if (p.prize) badges.push(html`<span class="badge gold">${raw(ART.nugget)} Prize here!</span>`);
  if (standing) badges.push(html`<span class="badge here">You're standing here</span>`);

  const info: Raw[] = [];
  info.push(row('Current price', dollars(p.price)));
  info.push(row('Max price', dollars(p.maxPrice)));
  if (p.ownerId != null) {
    info.push(row('Hourly rent', `${moneySmart(p.hourlyRentCents)}/h`));
    if (p.store) info.push(row('Business rent', `${moneySmart(p.businessRentCents)}/h`));
    info.push(row('Lock', locked ? `Locked for ${duration(lockLeft)}` : 'Open'));
    if (p.pricePaid != null && p.purchasedAt) info.push(row('Last sold', `${dollars(p.pricePaid)} · ${ago(p.purchasedAt, now)}`));
    if (mine && p.lastVisitAt) info.push(row('Your last visit', ago(p.lastVisitAt, now)));
  } else {
    info.push(row('Hourly rent if you own it', `${moneySmart(Math.round(CONFIG.MIN_MAX_PRICE * 100 * CONFIG.RENT_RATE))}/h`));
  }

  return html`
    <div class="parcel-head">
      <span class="swatch" style="background:${COLORS[color]}"></span>
      <div>
        <div class="owner">${ownerLine}</div>
        <div class="muted small">${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}${dist != null && !standing ? ` · ${distance(dist)} away` : ''}</div>
      </div>
      <div class="big-price">${dollars(p.price)}</div>
    </div>
    ${badges.length ? html`<div class="badges">${badges}</div>` : ''}
    <div class="actions-block">${actionsView(p, { mine, standing, locked, lockLeft, dist })}</div>
    ${p.store ? storeView(p, standing, mine) : ''}
    <div class="kv-grid">${info}</div>
    ${p.promotions.length
      ? html`<h3>Offers here</h3>${p.promotions.map(
          (o) => html`<div class="promo-card"><div class="promo-biz">${o.business}</div><div class="promo-title">${o.title}</div>
            ${o.body ? html`<p>${o.body}</p>` : ''}${o.url ? html`<a href="${o.url}" target="_blank" rel="noopener">More info</a>` : ''}</div>`,
        )}`
      : ''}
    ${p.history.length
      ? html`<h3>Deed history</h3><ul class="history">${p.history.map(
          (h) => html`<li><span>${h.from ?? 'Open land'} → <b>${h.to ?? 'released'}</b>${h.viaLawyer ? ' (Lawyer)' : ''}</span><span>${dollars(h.price)} · ${ago(h.time, now)}</span></li>`,
        )}</ul>`
      : ''}
  `;
}

function actionsView(
  p: ParcelDetail,
  s: { mine: boolean; standing: boolean; locked: boolean; lockLeft: number; dist: number | null },
): Raw {
  const me = state.me;
  if (!me) {
    return html`<a class="btn primary wide" href="#/login">Sign in to stake a claim</a>
      <p class="muted small">You can browse the map without an account. Buying land needs one.</p>`;
  }
  if (s.mine) {
    const parts: Raw[] = [];
    if (s.standing) {
      parts.push(html`<p class="ok-note">You're on your land. Each visit resets its price to max (${dollars(p.maxPrice)}).</p>`);
      if (!p.spook)
        parts.push(
          html`<button class="btn wide" data-action="spook" ${me.inventory.spooks < 1 ? 'disabled' : ''}>${raw(ART.ghost)} Place a Spook <span class="muted">(you have ${me.inventory.spooks})</span></button>`,
        );
      if (!p.store)
        parts.push(
          html`<button class="btn wide" data-action="store" ${me.inventory.permits < 1 ? 'disabled' : ''}>${raw(ART.cabin)} Build a store <span class="muted">(${me.inventory.permits} permit${me.inventory.permits === 1 ? '' : 's'})</span></button>`,
        );
      if (me.inventory.spooks < 1 && !p.spook) parts.push(html`<p class="muted small">Spooks are sold at stores and the <a href="#/office">Land Office</a>.</p>`);
      if (me.inventory.permits < 1 && !p.store)
        parts.push(html`<p class="muted small">A store needs a Building Permit (${dollars(CONFIG.PERMIT_PRICE)} at the <a href="#/office">Land Office</a>).</p>`);
    } else {
      parts.push(html`<p class="muted">Visit it to restore its price to max. Neglected land decays to half price over ${Math.round(CONFIG.DECAY_HOURS / 24)} days.</p>`);
    }
    return html`${parts}`;
  }
  if (s.locked) return html`<p class="warn-note">Just changed hands. Locked for ${duration(s.lockLeft)}.</p>`;
  if (me.frozen && p.ownerId != null)
    return html`<p class="warn-note">Your account is under review, so you can only buy unowned land for now.</p>`;

  const cash = me.cashCents;
  const afford = cash >= p.price * 100;
  const spookTake = p.spook ? spookTakeCents(p.price, cash - p.price * 100) : 0;
  const parts: Raw[] = [];
  if (s.standing) {
    const acc = state.fix?.accuracy ?? 999;
    if (acc > CONFIG.MAX_ACCURACY_M)
      parts.push(html`<p class="warn-note">Your GPS is only accurate to ±${Math.round(acc)} m; buying needs ${CONFIG.MAX_ACCURACY_M} m or better. Step outside or wait a moment.</p>`);
    parts.push(
      html`<button class="btn primary wide big" data-action="buy" ${afford ? '' : 'disabled'}>${p.ownerId == null ? 'Buy' : 'Jump this claim'} for ${dollars(p.price)}</button>`,
    );
    if (p.ownerId != null)
      parts.push(html`<p class="muted small">${p.owner} receives ${money(p.price * 100 * CONFIG.SELLER_SHARE, true)}. The new max price will be about ${dollars(Math.max(CONFIG.MIN_MAX_PRICE, Math.round((p.store ? p.price - CONFIG.STORE_PRICE_PREMIUM : p.price) * CONFIG.MAX_PRICE_MULTIPLIER)) + (p.store ? CONFIG.STORE_PRICE_PREMIUM : 0))}.</p>`);
    if (p.spook) {
      parts.push(
        me.inventory.flares > 0
          ? html`<label class="check"><input type="checkbox" id="use-flare" ${flareChoice ? 'checked' : ''}><span>Use a Flare on the Spook <span class="muted">(you have ${me.inventory.flares})</span></span></label>
                 <p class="muted small">Without a Flare the Spook takes ${money(spookTake, true)} from you.</p>`
          : html`<p class="warn-note">${raw(ART.ghost)} This parcel is spooked. With no Flare, it will take ${money(spookTake, true)} from you.</p>`,
      );
    }
  } else {
    parts.push(
      html`<p class="muted">${s.dist != null ? html`You're ${distance(s.dist)} away. ` : ''}Stand inside this parcel to buy it.</p>`,
    );
  }
  if (!afford) parts.push(html`<p class="warn-note">You need ${dollars(p.price)}; you have ${money(cash)}.</p>`);
  if (!s.standing && me.inventory.lawyers > 0) {
    const reach = lawyerReachKm(p.id, me);
    if (reach != null && reach <= CONFIG.LAWYER_RANGE_KM) {
      parts.push(
        html`<button class="btn wide" data-action="lawyer" ${afford ? '' : 'disabled'}>${raw(ART.lawyer)} Send a Lawyer: buy for ${dollars(p.price)} <span class="muted">(${me.inventory.lawyers} left)</span></button>`,
      );
      if (p.spook) parts.push(html`<p class="muted small">Lawyers can't use Flares, so the Spook will take ${money(spookTake, true)}.</p>`);
    } else if (reach != null) {
      parts.push(html`<p class="muted small">Lawyers reach ${CONFIG.LAWYER_RANGE_KM} km from your last verified location; this parcel is ${distance(reach)} away.</p>`);
    }
  }
  return html`${parts}`;
}

function storeView(p: ParcelDetail, standing: boolean, mine: boolean): Raw {
  const me = state.me;
  const sp = itemPrice('spook', 'store', mine)!;
  const fl = itemPrice('flare', 'store', mine)!;
  return html`<div class="store-box">
    <div class="store-head">${raw(ART.cabin)} <b>General store</b>${mine ? html` <span class="muted small">your store: half price</span>` : ''}</div>
    ${standing && me
      ? html`<div class="store-items">
          <button class="btn" data-action="shop" data-item="spook">${raw(ART.ghost)} Spook ${dollars(sp)}</button>
          <button class="btn" data-action="shop" data-item="flare">${raw(ART.flare)} Flare ${dollars(fl)}</button>
        </div>`
      : html`<p class="muted small">Stand in this parcel to shop: Spooks ${dollars(CONFIG.SPOOK_STORE_PRICE)}, Flares ${dollars(CONFIG.FLARE_STORE_PRICE)} (half the Land Office price).</p>`}
  </div>`;
}

/** Bound once per sheet; handlers act on whichever parcel is currently shown. */
function bind(body: HTMLElement) {
  const withParcel = (fn: (p: ParcelDetail, el: HTMLElement) => unknown) => (el: HTMLElement) => {
    if (current) fn(current, el);
  };
  actions(body, {
    buy: withParcel((p, el) => busy(el, () => buy(p, false))),
    lawyer: withParcel(async (p, el) => {
      const ok = await dialog({
        title: 'Send a Lawyer?',
        body: html`Buy parcel <b>${p.id}</b> for <b>${dollars(p.price)}</b> without being there. This uses 1 of your ${state.me?.inventory.lawyers} Lawyers.`,
        actions: [
          { label: 'Cancel', value: 'cancel' },
          { label: 'Send the Lawyer', value: 'go', kind: 'primary' },
        ],
      });
      if (ok === 'go') await busy(el, () => buy(p, true));
    }),
    spook: withParcel((p, el) => busy(el, () => placeItem(p, 'spook'))),
    store: withParcel(async (p, el) => {
      const ok = await dialog({
        title: 'Build a store?',
        body: html`Use your Building Permit to open a general store here. It earns ${money(CONFIG.BUSINESS_RENT_CENTS_PER_HOUR)}/h business rent and half of every sale to other players. It adds ${dollars(CONFIG.STORE_PRICE_PREMIUM)} to the parcel's price, which no longer decays, and goes with the parcel if it's jumped.`,
        actions: [
          { label: 'Cancel', value: 'cancel' },
          { label: 'Build it', value: 'go', kind: 'primary' },
        ],
      });
      if (ok === 'go') await busy(el, () => placeItem(p, 'store'));
    }),
    shop: withParcel((p, el) =>
      busy(el, async () => {
        const fix = await freshFix();
        const item = el.dataset.item as 'spook' | 'flare';
        const r = await api('POST', '/shop/buy', { item, qty: 1, place: 'store', parcelId: p.id, fix: fix ? toApiFix(fix) : undefined }, { idempotencyKey: uuid() });
        setMe(r.me);
        toast(`Bought a ${item === 'spook' ? 'Spook' : 'Flare'} for ${money(r.paidCents)}.`, 'good');
      }),
    ),
  });
}

async function buy(p: ParcelDetail, useLawyer: boolean) {
  const useFlare = !!(document.getElementById('use-flare') as HTMLInputElement | null)?.checked;
  const fix = useLawyer ? null : await freshFix();
  if (!useLawyer && fix && cellIdOf(fix.lat, fix.lng) !== p.id) {
    toast("You've stepped out of this parcel.", 'bad');
    rerender();
    return;
  }
  try {
    const r = await api<BuyResult>(
      'POST',
      `/parcels/${encodeURIComponent(p.id)}/buy`,
      { fix: fix ? toApiFix(fix) : undefined, useFlare, useLawyer, maxPrice: p.price },
      { idempotencyKey: uuid() },
    );
    setMe(r.me);
    current = r.parcel;
    upsertParcel(r.parcel);
    rerender();
    let msg = `Parcel ${p.id} is yours for ${dollars(r.paid)}!`;
    if (r.seller) msg = `You jumped ${r.seller}'s claim for ${dollars(r.paid)}!`;
    toast(msg, 'good', 5000);
    if (r.spook?.outcome === 'triggered') toast(`Boo! The Spook took ${money(r.spook.takenCents, true)} from you.`, 'bad', 6000);
    if (r.spook?.outcome === 'flared') toast('Your Flare burned off the Spook.', 'gold');
    navigator.vibrate?.(60);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'price_changed') {
      toast(err.message, 'bad');
      await load(p.id);
      return;
    }
    if (err instanceof ApiError && (err.code === 'locked' || err.code === 'not_here')) await load(p.id);
    throw err;
  }
}

async function placeItem(p: ParcelDetail, what: 'spook' | 'store') {
  const fix = await freshFix();
  const r = await api('POST', `/parcels/${encodeURIComponent(p.id)}/${what}`, { fix: fix ? toApiFix(fix) : undefined }, { idempotencyKey: uuid() });
  setMe(r.me);
  current = r.parcel;
  upsertParcel(r.parcel);
  rerender();
  toast(what === 'spook' ? 'Your Spook is haunting this parcel.' : 'Your store is open for business!', 'good');
}

/** Called when the GPS moves; refresh the open parcel sheet only when "standing here" flips. */
export function parcelSheetFixChanged() {
  if (currentId && standingOn(currentId) !== lastStanding) rerender();
}

