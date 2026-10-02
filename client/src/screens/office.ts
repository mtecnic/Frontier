import { CONFIG } from '../../../shared/config.ts';
import type { Me } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { ART } from '../art.ts';
import { setMe, state, on } from '../state.ts';
import { actions, busy, guide, openSheet, setSheetBody, sheetBody, toast } from '../ui.ts';
import { dollars, html, money, raw, uuid, type Raw } from '../util.ts';
import { requireLogin } from './login.ts';

type Item = 'lawyer' | 'permit' | 'spook' | 'flare';

const ITEMS: { key: Item; name: string; art: string; price: () => number; cap: () => number | null; desc: () => Raw }[] = [
  {
    key: 'lawyer',
    name: 'Lawyer',
    art: ART.lawyer,
    price: () => CONFIG.LAWYER_PRICE,
    cap: () => null,
    desc: () =>
      html`Buys one parcel within ${CONFIG.LAWYER_RANGE_KM} km of your last verified location without walking there. Can't use a Flare, so any Spook on it will bite.`,
  },
  {
    key: 'permit',
    name: 'Building Permit',
    art: ART.permit,
    price: () => CONFIG.PERMIT_PRICE,
    cap: () => null,
    desc: () =>
      html`Build a general store on land you own while standing on it. Stores earn ${money(CONFIG.BUSINESS_RENT_CENTS_PER_HOUR)}/h plus half of every sale, and their price never decays.`,
  },
  {
    key: 'spook',
    name: 'Spook',
    art: ART.ghost,
    price: () => CONFIG.SPOOK_OFFICE_PRICE,
    cap: () => CONFIG.MAX_SPOOKS,
    desc: () =>
      html`Haunt a parcel you own (stand on it to place). When someone jumps it, it takes the larger of ${dollars(CONFIG.SPOOK_MIN_TAKE)} or ${Math.round(CONFIG.SPOOK_TAKE_FRACTION * 100)}% of the price from them and pays you. Stores sell them for ${dollars(CONFIG.SPOOK_STORE_PRICE)}.`,
  },
  {
    key: 'flare',
    name: 'Flare',
    art: ART.flare,
    price: () => CONFIG.FLARE_OFFICE_PRICE,
    cap: () => CONFIG.MAX_FLARES,
    desc: () => html`Burn off a Spook as you buy a haunted parcel, before it can steal. Stores sell them for ${dollars(CONFIG.FLARE_STORE_PRICE)}.`,
  },
];

const COLUMN: Record<Item, keyof Me['inventory']> = { lawyer: 'lawyers', permit: 'permits', spook: 'spooks', flare: 'flares' };

let unsub: (() => void) | null = null;

export function showOffice() {
  requireLogin(() => {
    openSheet({
      title: 'Land Office',
      body: '',
      className: 'office-sheet',
      onClose: () => {
        unsub?.();
        unsub = null;
      },
    });
    actions(sheetBody()!, {
      buy: (el) =>
        busy(el, async () => {
          const item = el.dataset.item as Item;
          const r = await api<{ me: Me; paidCents: number }>('POST', '/shop/buy', { item, qty: 1, place: 'office' }, { idempotencyKey: uuid() });
          setMe(r.me);
          toast(`Bought a ${ITEMS.find((i) => i.key === item)!.name} for ${money(r.paidCents)}.`, 'good');
        }),
    });
    render();
    unsub?.();
    unsub = on('me', render);
  });
}

function render() {
  const me = state.me;
  if (!me || !sheetBody()) return;
  setSheetBody(html`
    ${guide(
      html`Come on in. I sell Lawyers and Building Permits, and I keep Spooks and Flares behind the counter at double what the stores charge. You have <b>${money(me.cashCents, true)}</b>.`,
      ART.mabel,
    )}
    <div class="shop-list">
      ${ITEMS.map((it) => {
        const have = me.inventory[COLUMN[it.key]];
        const cap = it.cap();
        const full = cap != null && have >= cap;
        const afford = me.cashCents >= it.price() * 100;
        return html`<div class="shop-item">
          <div class="shop-art">${raw(it.art)}</div>
          <div class="shop-info">
            <div class="shop-name">${it.name} <span class="muted small">you have ${have}${cap != null ? ` / ${cap}` : ''}</span></div>
            <p>${it.desc()}</p>
          </div>
          <button class="btn primary" data-action="buy" data-item="${it.key}" ${full || !afford ? 'disabled' : ''}>${dollars(it.price())}</button>
        </div>`;
      })}
    </div>
    <p class="muted small">Every purchase here leaves the economy. Stores give half their sales to the store owner.</p>
  `);
}
