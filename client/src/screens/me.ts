import { startRegistration } from '@simplewebauthn/browser';
import { CONFIG } from '../../../shared/config.ts';
import type { Me, ParcelView, Summary } from '../../../shared/types.ts';
import { api, setToken } from '../api.ts';
import { ART, ICON } from '../art.ts';
import { COLORS, flyToCell } from '../map.ts';
import { parcelColor } from '../../../shared/pricing.ts';
import { pushSupported, pushEnabled, enablePush, disablePush } from '../push.ts';
import { on, serverNow, setMe, state } from '../state.ts';
import { actions, busy, closeSheet, dialog, openSheet, setSheetBody, sheetBody, toast } from '../ui.ts';
import { ago, dollars, html, money, moneySmart, plural, raw, store, type Raw } from '../util.ts';
import { summaryTable } from './summary.ts';
import { requireLogin } from './login.ts';

const LEDGER_LABEL: Record<string, string> = {
  start: 'Starting cash',
  salary: 'Salary',
  rent: 'Common rent',
  business_rent: 'Business rent',
  purchase: 'Bought land',
  sale: 'Land sold (jumped)',
  spook_paid: 'Spooked!',
  spook_stolen: 'Spook takings',
  item: 'Supplies',
  store_proceeds: 'Store proceeds',
  prize: 'Prize',
  admin: 'Adjustment',
};

let unsub: (() => void) | null = null;

export function showMe() {
  requireLogin(async () => {
    openSheet({
      title: 'User Details',
      body: html`<div class="loading">Opening your ledger...</div>`,
      className: 'me-sheet',
      onClose: () => {
        unsub?.();
        unsub = null;
      },
    });
    await render();
  });
}

async function render() {
  const [meRes, parcels, ledger, pushOn] = await Promise.all([
    api<{ me: Me; summary: Summary }>('GET', '/me'),
    api<(ParcelView & { lastVisitAt: string; hourlyRentCents: number })[]>('GET', '/me/parcels'),
    api<{ id: number; time: string; type: string; amount_cents: number; parcel_id: string | null; other: string | null; note: string | null }[]>('GET', '/me/ledger'),
    pushEnabled(),
  ]);
  setMe(meRes.me);
  const me = meRes.me;
  const now = serverNow();
  if (!sheetBody()) return;
  setSheetBody(html`
    <div class="me-head">
      <div class="me-avatar">${raw(ART.avatar)}</div>
      <div>
        <div class="me-name">${me.username}${me.isAdmin ? html` <span class="badge">admin</span>` : ''}</div>
        <div class="muted small">${me.email} · joined ${ago(me.createdAt, now)}</div>
      </div>
    </div>
    ${me.frozen ? html`<p class="warn-note">Your account is under review. You can keep playing, but you can't buy other players' land until an admin clears it.</p>` : ''}
    <div class="stat-row">
      <div class="stat"><span>Cash</span><b>${money(me.cashCents, true)}</b></div>
      <div class="stat"><span>Income</span><b>${moneySmart(me.hourlyIncomeCents)}/h</b></div>
      <div class="stat"><span>Parcels</span><b>${me.parcelsOwned.toLocaleString()}</b></div>
      <div class="stat"><span>Land value</span><b>${dollars(me.landValue)}</b></div>
    </div>
    <div class="inv-row">
      ${inv(ART.lawyer, 'Lawyers', me.inventory.lawyers)}
      ${inv(ART.permit, 'Permits', me.inventory.permits)}
      ${inv(ART.ghost, 'Spooks', me.inventory.spooks, CONFIG.MAX_SPOOKS)}
      ${inv(ART.flare, 'Flares', me.inventory.flares, CONFIG.MAX_FLARES)}
    </div>

    <details class="card" open>
      <summary>Since last login</summary>
      ${summaryTable(meRes.summary)}
    </details>

    <details class="card" ${parcels.length && parcels.length <= 30 ? 'open' : ''}>
      <summary>Your land (${plural(parcels.length, 'parcel')})</summary>
      ${parcels.length
        ? html`<ul class="parcel-list">${parcels.map((p) => {
            const color = COLORS[parcelColor(p.ownerId, me.id, p.price)];
            const decayed = p.price < p.maxPrice;
            return html`<li data-action="goto" data-id="${p.id}">
              <span class="swatch" style="background:${color}"></span>
              <span class="mono">${p.id}</span>
              ${p.store ? raw(ART.cabin) : ''}${p.spook ? raw(ART.ghost) : ''}
              <span class="grow"></span>
              <span class="${decayed ? 'decay' : ''}">${dollars(p.price)}<span class="muted"> / ${dollars(p.maxPrice)}</span></span>
              <span class="muted small">visited ${ago(p.lastVisitAt, now)}</span>
            </li>`;
          })}</ul>`
        : html`<p class="muted">No land yet. Walk into any blue parcel and buy it for ${dollars(CONFIG.UNOWNED_PRICE)}.</p>`}
    </details>

    <details class="card">
      <summary>Ledger</summary>
      <ul class="ledger-list">${ledger.map(
        (l) => html`<li>
          <span><b>${LEDGER_LABEL[l.type] ?? l.type}</b>${l.parcel_id ? html` <a href="#/parcel/${l.parcel_id}" class="mono">${l.parcel_id}</a>` : ''}${l.other ? html` <span class="muted">· ${l.other}</span>` : ''}${l.note ? html`<br><span class="muted small">${l.note}</span>` : ''}</span>
          <span class="${l.amount_cents < 0 ? 'neg' : 'pos'}">${l.amount_cents < 0 ? '' : '+'}${money(l.amount_cents, true)}<br><span class="muted small">${ago(l.time, now)}</span></span>
        </li>`,
      )}</ul>
    </details>

    <div class="card settings">
      <h3>Settings</h3>
      ${pushSupported()
        ? html`<label class="switch"><input type="checkbox" data-setting="push" ${pushOn ? 'checked' : ''}> ${raw(ICON.bell)} Jump alerts on this device</label>`
        : html`<p class="muted small">${raw(ICON.bell)} Jump alerts need a browser with Web Push. On iPhone, add ${CONFIG.GAME_NAME} to your Home Screen first.</p>`}
      <label class="switch"><input type="checkbox" data-setting="wake" ${state.wake ? 'checked' : ''}> ${raw(ICON.sun)} Keep the screen awake in follow mode</label>
      ${state.features.passkeys && 'PublicKeyCredential' in window
        ? html`<button class="btn" data-action="passkey">${raw(ICON.key)} ${me.hasPasskey ? 'Add another passkey' : 'Add a passkey'}</button>`
        : ''}
      <button class="btn" data-action="rename">Change username</button>
      ${me.isAdmin ? html`<a class="btn" href="#/admin">${raw(ICON.admin)} Admin</a>` : ''}
      <button class="btn" data-action="logout">${raw(ICON.out)} Sign out</button>
      <button class="btn danger-link" data-action="delete">Delete my account</button>
    </div>
  `);

  const body = sheetBody()!;
  body.querySelector<HTMLInputElement>('[data-setting="push"]')?.addEventListener('change', async (e) => {
    const box = e.target as HTMLInputElement;
    try {
      if (box.checked) {
        await enablePush();
        toast("Jump alerts are on. We'll tell you when someone takes your land.", 'good');
      } else {
        await disablePush();
        toast('Jump alerts are off on this device.');
      }
    } catch (err) {
      box.checked = !box.checked;
      toast((err as Error).message, 'bad');
    }
  });
  body.querySelector<HTMLInputElement>('[data-setting="wake"]')?.addEventListener('change', (e) => {
    state.wake = (e.target as HTMLInputElement).checked;
    store('wake', state.wake);
    document.dispatchEvent(new CustomEvent('frontier:wake'));
  });

  unsub?.();
  unsub = on('me', () => {
    const cash = sheetBody()?.querySelector('.stat b');
    if (cash && state.me) cash.textContent = money(state.me.cashCents, true);
  });
  if (body.dataset.bound) return;
  body.dataset.bound = '1';
  actions(body, {
    goto: (el) => {
      closeSheet();
      flyToCell(el.dataset.id!);
      location.hash = `#/parcel/${el.dataset.id}`;
    },
    passkey: (el) =>
      busy(el, async () => {
        const options = await api('POST', '/auth/passkey/register/options', {});
        let response;
        try {
          response = await startRegistration({ optionsJSON: options });
        } catch {
          toast('Passkey setup was cancelled.');
          return;
        }
        await api('POST', '/auth/passkey/register/verify', { response });
        toast('Passkey added. Next time you can sign in without email.', 'good');
        render();
      }),
    rename: async () => {
      const current = state.me?.username ?? '';
      const name = await promptText('Change username', `Your new name, ${CONFIG.USERNAME_MIN}-${CONFIG.USERNAME_MAX} letters, numbers, _ or -.`, current);
      if (!name || name === current) return;
      try {
        const r = await api<{ me: Me }>('PATCH', '/me', { username: name });
        setMe(r.me);
        toast(`You're now ${r.me.username}.`, 'good');
        render();
      } catch (err) {
        toast((err as Error).message, 'bad');
      }
    },
    logout: (el) =>
      busy(el, async () => {
        await api('POST', '/auth/logout', {});
        setToken(null);
        setMe(null);
        closeSheet(true);
        toast('Signed out. Your land stays yours.');
      }),
    delete: async () => {
      const typed = await promptText(
        'Delete your account?',
        `This releases all ${state.me?.parcelsOwned ?? 0} of your parcels back to open land and removes your stores. It can't be undone. Type your username to confirm.`,
        '',
      );
      if (!typed) return;
      try {
        await api('DELETE', '/me', { confirm: typed });
        setToken(null);
        setMe(null);
        closeSheet(true);
        toast('Your account was deleted.');
      } catch (err) {
        toast((err as Error).message, 'bad');
      }
    },
  });
}

function inv(art: string, label: string, n: number, cap?: number): Raw {
  return html`<div class="inv"><div class="inv-art">${raw(art)}</div><b>${n}</b><span>${label}${cap ? html`<span class="muted"> / ${cap}</span>` : ''}</span></div>`;
}

export async function promptText(title: string, text: string, value: string): Promise<string | null> {
  const id = `prompt-${Date.now()}`;
  const choice = await dialog({
    title,
    body: html`<p>${text}</p><input class="text-input" id="${id}" value="${value}" autocomplete="off">`,
    actions: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'OK', value: 'ok', kind: 'primary' },
    ],
  });
  const input = document.getElementById(id) as HTMLInputElement | null;
  const v = input?.value.trim() ?? '';
  return choice === 'ok' ? v : null;
}
