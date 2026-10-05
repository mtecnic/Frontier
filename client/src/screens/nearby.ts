import { CONFIG } from '../../../shared/config.ts';
import { bearingDeg, cellCenter, compassPoint } from '../../../shared/grid.ts';
import type { ClaimedPrize, PrizeView, PromotionView } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { ART } from '../art.ts';
import { flyToCell } from '../map.ts';
import { serverNow, state } from '../state.ts';
import { actions, closeSheet, guide, openSheet, setSheetBody, sheetBody } from '../ui.ts';
import { ago, distance, duration, html, money, raw } from '../util.ts';
import { requireLogin } from './login.ts';

function direction(gy: number, gx: number): string {
  const f = state.fix ?? (state.me?.lastFix ? { lat: state.me.lastFix.lat, lng: state.me.lastFix.lng } : null);
  if (!f) return '';
  const c = cellCenter(gy, gx);
  return compassPoint(bearingDeg(f.lat, f.lng, c.lat, c.lng));
}

function gotoHandler(body: HTMLElement) {
  actions(body, {
    goto: (el) => {
      closeSheet();
      flyToCell(el.dataset.id!, 15);
      location.hash = `#/parcel/${el.dataset.id}`;
    },
  });
}

export function showPrizes() {
  requireLogin(async () => {
    openSheet({ title: 'Prizes', body: html`<div class="loading">Checking the creek beds...</div>` });
    gotoHandler(sheetBody()!);
    const r = await api<{ nearby: PrizeView[]; claimed: ClaimedPrize[]; hasFix: boolean }>('GET', '/prizes');
    const now = serverNow();
    setSheetBody(html`
      ${guide(
        r.nearby.length
          ? html`I've heard of ${r.nearby.length === 1 ? 'a gold nugget' : `${r.nearby.length} gold nuggets`} within ${CONFIG.PRIZE_VISIBLE_KM} km of you. First one to stand on the parcel takes it, whoever owns the land.`
          : r.hasFix
            ? html`No nuggets within ${CONFIG.PRIZE_VISIBLE_KM} km right now. New ones turn up every night near folks who've played this week, within ${CONFIG.PRIZE_SPAWN_RADIUS_KM} km of where they were last seen.`
            : html`Share your location and I'll point you to any gold nuggets within ${CONFIG.PRIZE_VISIBLE_KM} km.`,
        ART.mabel,
      )}
      ${r.nearby.length
        ? html`<ul class="near-list">${r.nearby.map(
            (p) => html`<li data-action="goto" data-id="${p.parcelId}">
              <span class="near-art">${raw(ART.nugget)}</span>
              <span class="grow"><b>${distance(p.distanceKm ?? 0)} ${direction(p.gy, p.gx)}</b><br><span class="muted small">parcel ${p.parcelId}</span></span>
              <span class="muted small">gone in ${duration(Date.parse(p.expiresAt) - now)}</span>
            </li>`,
          )}</ul>`
        : ''}
      <h3>Your finds</h3>
      ${r.claimed.length
        ? html`<ul class="near-list">${r.claimed.map(
            (c) => html`<li data-action="goto" data-id="${c.parcelId}">
              <span class="near-art">${raw(c.kind === 'lawyer' ? ART.lawyer : ART.nugget)}</span>
              <span class="grow"><b>${c.kind === 'lawyer' ? 'A Lawyer!' : money(c.amountCents)}</b><br><span class="muted small">parcel ${c.parcelId}</span></span>
              <span class="muted small">${ago(c.claimedAt, now)}</span>
            </li>`,
          )}</ul>`
        : html`<p class="muted">Nothing yet. Prizes pay $10 to $100, and one in ${CONFIG.PRIZE_LAWYER_ONE_IN} is a free Lawyer.</p>`}
    `);
  });
}

export async function showPromotions() {
  openSheet({ title: 'Promotions', body: html`<div class="loading">Reading the notice board...</div>` });
  gotoHandler(sheetBody()!);
  const f = state.fix;
  const q = !state.signedIn && f ? `?lat=${f.lat}&lng=${f.lng}` : '';
  const r = await api<{ nearby: PromotionView[]; hasLocation: boolean }>('GET', `/promotions${q}`);
  setSheetBody(html`
    ${guide(
      r.nearby.length
        ? html`Local businesses posted these offers within ${CONFIG.PROMO_VISIBLE_KM} km of you.`
        : r.hasLocation
          ? html`No offers posted within ${CONFIG.PROMO_VISIBLE_KM} km of you yet. Look for printed ${CONFIG.GAME_NAME} codes at local shops too: scan one while you're there for a free Flare.`
          : html`Share your location to see offers from businesses within ${CONFIG.PROMO_VISIBLE_KM} km.`,
      ART.mabel,
    )}
    ${r.nearby.map(
      (p) => html`<div class="promo-card">
        <div class="promo-biz">${raw(ART.promo)} ${p.business} <span class="muted small">· ${distance(p.distanceKm ?? 0)} ${direction(p.gy, p.gx)}</span></div>
        <div class="promo-title">${p.title}</div>
        ${p.body ? html`<p>${p.body}</p>` : ''}
        <div class="promo-actions">
          <button class="btn small" data-action="goto" data-id="${p.parcelId}">Show on map</button>
          ${p.url ? html`<a class="btn small" href="${p.url}" target="_blank" rel="noopener">Website</a>` : ''}
          ${p.endsAt ? html`<span class="muted small">until ${new Date(p.endsAt).toLocaleDateString()}</span>` : ''}
        </div>
      </div>`,
    )}
  `);
}
