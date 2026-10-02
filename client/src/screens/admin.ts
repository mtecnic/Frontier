import qrcode from 'qrcode-generator';
import { cellIdOf } from '../../../shared/grid.ts';
import { api } from '../api.ts';
import { getMap } from '../map.ts';
import { state } from '../state.ts';
import { actions, busy, openSheet, setSheetBody, sheetBody, toast } from '../ui.ts';
import { ago, escapeHtml, html, money, type Raw } from '../util.ts';

type Tab = 'overview' | 'flags' | 'users' | 'promos' | 'qr';
let tab: Tab = 'overview';
let userId: number | null = null;
let search = '';

const FLAG_TEXT: Record<string, string> = {
  identical_accuracy: 'Many fixes with identical accuracy across cells (possible spoofer)',
  straight_line: 'Purchases stepping through the grid in a straight line',
  feeds_one_seller: 'New account whose purchases mostly pay one seller',
  purchases_per_day: 'More than the daily purchase threshold',
  ledger_mismatch: "Cash doesn't match the ledger",
};

export function showAdmin() {
  if (!state.me?.isAdmin) {
    toast('Admins only.', 'bad');
    location.hash = '#/';
    return;
  }
  openSheet({ title: 'Admin', body: '', className: 'admin-sheet wide' });
  const body = sheetBody()!;
  actions(body, {
    tab: (el) => {
      tab = el.dataset.tab as Tab;
      userId = null;
      render();
    },
    user: (el) => {
      tab = 'users';
      userId = Number(el.dataset.id);
      render();
    },
    back: () => {
      userId = null;
      render();
    },
    freeze: (el) =>
      busy(el, async () => {
        const frozen = el.dataset.frozen === '1';
        await api('POST', `/admin/users/${el.dataset.id}/freeze`, { frozen, resolveFlags: !frozen });
        toast(frozen ? 'Account frozen.' : 'Account cleared.', 'good');
        render();
      }),
    resolve: (el) =>
      busy(el, async () => {
        const note = (body.querySelector(`#note-${el.dataset.id}`) as HTMLInputElement | null)?.value ?? '';
        await api('POST', `/admin/flags/${el.dataset.id}/resolve`, { note });
        render();
      }),
    nightly: (el) =>
      busy(el, async () => {
        const r = await api('POST', '/admin/nightly', {});
        toast(`Nightly job done: ${JSON.stringify(r).slice(0, 120)}...`, 'good', 6000);
        render();
      }),
    audit: (el) =>
      busy(el, async () => {
        const r = await api<{ checked: number; mismatches: unknown[] }>('POST', '/admin/audit', {});
        toast(`Checked ${r.checked} accounts: ${r.mismatches.length} mismatches.`, r.mismatches.length ? 'bad' : 'good', 6000);
      }),
    here: (el) => {
      const form = el.closest('form') as HTMLFormElement;
      const c = state.fix ?? (() => {
        const m = getMap().getCenter();
        return { lat: m.lat, lng: m.lng };
      })();
      (form.elements.namedItem('parcelId') as HTMLInputElement).value = cellIdOf(c.lat, c.lng);
    },
    'promo-toggle': (el) =>
      busy(el, async () => {
        await api('PATCH', `/admin/promotions/${el.dataset.id}`, { active: el.dataset.active === '1' });
        render();
      }),
    'qr-toggle': (el) =>
      busy(el, async () => {
        await api('PATCH', `/admin/qr/${el.dataset.id}`, { active: el.dataset.active === '1' });
        render();
      }),
    'qr-print': (el) => printQr(el.dataset.token!, el.dataset.name!, el.dataset.parcel!),
  });
  body.addEventListener('submit', async (e) => {
    const form = e.target as HTMLFormElement;
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    const btn = form.querySelector('button[type=submit]') as HTMLElement;
    if (form.dataset.form === 'search') {
      search = String(data.search ?? '');
      render();
      return;
    }
    await busy(btn, async () => {
      if (form.dataset.form === 'promo') {
        await api('POST', '/admin/promotions', data);
        toast('Promotion posted.', 'good');
      } else if (form.dataset.form === 'qr') {
        await api('POST', '/admin/qr', data);
        toast('QR station created. Print its code below.', 'good');
      }
      render();
    });
  });
  render();
}

function tabs(): Raw {
  const t = (k: Tab, label: string) => html`<button class="${tab === k ? 'on' : ''}" data-action="tab" data-tab="${k}">${label}</button>`;
  return html`<div class="seg">${t('overview', 'Overview')}${t('flags', 'Flags')}${t('users', 'Users')}${t('promos', 'Offers')}${t('qr', 'QR')}</div>`;
}

async function render() {
  setSheetBody(html`${tabs()}<div class="loading">Loading...</div>`);
  let content: Raw;
  try {
    content =
      tab === 'overview'
        ? await overview()
        : tab === 'flags'
          ? await flags()
          : tab === 'users'
            ? userId
              ? await userDetail(userId)
              : await users()
            : tab === 'promos'
              ? await promos()
              : await stations();
  } catch (err) {
    content = html`<p class="error">${(err as Error).message}</p>`;
  }
  if (sheetBody()) setSheetBody(html`${tabs()}${content}`);
}

async function overview(): Promise<Raw> {
  const r = await api<{ stats: Record<string, number>; nightly: any; publicUrl: string }>('GET', '/admin/stats');
  const s = r.stats;
  const stat = (label: string, v: string | number) => html`<div class="stat"><span>${label}</span><b>${v}</b></div>`;
  return html`
    <div class="stat-row wrap">
      ${stat('Players', s.users ?? 0)}${stat('Active 24h', s.active1d ?? 0)}${stat('Active 7d', s.active7d ?? 0)}
      ${stat('Parcels', s.parcels ?? 0)}${stat('Stores', s.stores ?? 0)}${stat('Spooks', s.spooks ?? 0)}
      ${stat('Money supply', money(s.money_supply_cents ?? 0))}${stat('Sales 24h', s.sales24h ?? 0)}${stat('Live prizes', s.live_prizes ?? 0)}
      ${stat('Open flags', s.open_flags ?? 0)}${stat('Frozen', s.frozen ?? 0)}
    </div>
    <h3>Nightly job</h3>
    ${r.nightly
      ? html`<p>Last run for <b>${r.nightly.day}</b>, started ${ago(r.nightly.started_at)}${r.nightly.finished_at ? '' : ' (not finished)'}.</p>
             <pre class="pre">${JSON.stringify(r.nightly.result, null, 2)}</pre>`
      : html`<p class="muted">Hasn't run yet.</p>`}
    <div class="row-btns">
      <button class="btn" data-action="nightly">Run nightly job now</button>
      <button class="btn" data-action="audit">Audit the ledger</button>
    </div>`;
}

async function flags(): Promise<Raw> {
  const rows = await api<any[]>('GET', '/admin/flags');
  if (!rows.length) return html`<p class="muted">No open flags. Quiet out on the range.</p>`;
  return html`<ul class="admin-list">${rows.map(
    (f) => html`<li>
      <div><b>${f.username}</b>${f.frozen ? html` <span class="badge bad">frozen</span>` : ''} <span class="muted small">${ago(f.created_at)}</span></div>
      <div>${FLAG_TEXT[f.kind] ?? f.kind}</div>
      <pre class="pre small">${JSON.stringify(f.detail)}</pre>
      <div class="row-btns">
        <button class="btn small" data-action="user" data-id="${f.user_id}">Review player</button>
        ${f.frozen
          ? html`<button class="btn small" data-action="freeze" data-id="${f.user_id}" data-frozen="0">Clear &amp; unfreeze</button>`
          : html`<button class="btn small danger" data-action="freeze" data-id="${f.user_id}" data-frozen="1">Freeze</button>`}
        <input id="note-${f.id}" class="text-input small" placeholder="note">
        <button class="btn small" data-action="resolve" data-id="${f.id}">Dismiss</button>
      </div>
    </li>`,
  )}</ul>`;
}

async function users(): Promise<Raw> {
  const rows = await api<any[]>('GET', `/admin/users?search=${encodeURIComponent(search)}`);
  return html`
    <form class="inline-form" data-form="search"><input name="search" class="text-input" placeholder="username, email or id" value="${search}"><button class="btn" type="submit">Search</button></form>
    <ul class="admin-list">${rows.map(
      (u) => html`<li data-action="user" data-id="${u.id}" class="clickable">
        <b>${u.username}</b> ${u.is_admin ? html`<span class="badge">admin</span>` : ''}${u.frozen ? html`<span class="badge bad">frozen</span>` : ''}${u.deleted_at ? html`<span class="badge">deleted</span>` : ''}
        <span class="muted small">${u.email ?? ''} · ${money(u.cash_cents)} · ${u.parcels} parcels · ${u.open_flags} flags · seen ${ago(u.last_open_at)}</span>
      </li>`,
    )}</ul>`;
}

async function userDetail(id: number): Promise<Raw> {
  const r = await api<any>('GET', `/admin/users/${id}`);
  const u = r.user;
  return html`
    <button class="btn small" data-action="back">← All users</button>
    <h3>${u.username} <span class="muted small">#${u.id}</span></h3>
    <p>${u.email ?? '(deleted)'} · joined ${ago(u.created_at)} · signup IP ${u.signup_ip ?? '?'}</p>
    <p>Cash ${money(u.cash_cents, true)} · ledger ${money(u.ledger_cents, true)} ${u.cash_cents === u.ledger_cents ? '✓' : html`<span class="badge bad">MISMATCH</span>`}</p>
    <p>${r.parcels.n} parcels · Lawyers ${u.lawyers} · Permits ${u.permits} · Spooks ${u.spooks} · Flares ${u.flares}</p>
    <div class="row-btns">
      ${u.frozen
        ? html`<button class="btn" data-action="freeze" data-id="${u.id}" data-frozen="0">Clear &amp; unfreeze</button>`
        : html`<button class="btn danger" data-action="freeze" data-id="${u.id}" data-frozen="1">Freeze account</button>`}
    </div>
    <p class="muted small">Frozen accounts keep playing, but can't buy other players' land; their Spooks fizzle and their store purchases don't pay the owner.</p>
    <h3>Flags</h3>
    ${r.flags.length ? html`<ul class="admin-list">${r.flags.map((f: any) => html`<li>${FLAG_TEXT[f.kind] ?? f.kind} <span class="muted small">${ago(f.created_at)}${f.resolved_at ? ' · resolved' : ''}</span></li>`)}</ul>` : html`<p class="muted">None.</p>`}
    <h3>Recent fixes</h3>
    <table class="data"><tr><th>When</th><th>Where</th><th>±m</th><th></th></tr>
      ${r.fixes.slice(0, 40).map(
        (f: any) => html`<tr><td>${ago(f.time)}</td><td class="mono">${f.lat != null ? `${Number(f.lat).toFixed(5)}, ${Number(f.lng).toFixed(5)}` : ''}</td><td>${f.accuracy != null ? Math.round(f.accuracy) : ''}</td><td>${f.accepted ? '✓' : f.reason}</td></tr>`,
      )}
    </table>
    <h3>Deeds</h3>
    <table class="data"><tr><th>When</th><th>Parcel</th><th>From → To</th><th>Price</th></tr>
      ${r.deeds.slice(0, 40).map(
        (d: any) => html`<tr><td>${ago(d.time)}</td><td class="mono">${d.parcel_id}</td><td>${d.from_name ?? '—'} → ${d.to_name ?? '—'}</td><td>${money(d.price_cents)}</td></tr>`,
      )}
    </table>
    <h3>Ledger</h3>
    <table class="data"><tr><th>When</th><th>Type</th><th>Amount</th><th>Other</th></tr>
      ${r.ledger.slice(0, 60).map(
        (l: any) => html`<tr><td>${ago(l.time)}</td><td>${l.type}</td><td>${money(l.amount_cents, true)}</td><td>${l.other ?? ''}</td></tr>`,
      )}
    </table>`;
}

function locationFields(): Raw {
  return html`<label>Parcel ID<span class="row"><input name="parcelId" class="text-input" placeholder="7233:-23028" required><button class="btn small" type="button" data-action="here">Use my spot</button></span></label>`;
}

async function promos(): Promise<Raw> {
  const rows = await api<any[]>('GET', '/admin/promotions');
  return html`
    <form class="form card" data-form="promo">
      <h3>Post an offer</h3>
      ${locationFields()}
      <label>Business<input name="business" class="text-input" required maxlength="80"></label>
      <label>Headline<input name="title" class="text-input" required maxlength="120"></label>
      <label>Details<textarea name="body" class="text-input" maxlength="1000" rows="3"></textarea></label>
      <label>Link (optional)<input name="url" type="url" class="text-input" placeholder="https://"></label>
      <label>Ends (optional)<input name="endsAt" type="date" class="text-input"></label>
      <button class="btn primary" type="submit">Post offer</button>
    </form>
    <ul class="admin-list">${rows.map(
      (p) => html`<li>
        <b>${p.business}</b>: ${p.title} <span class="muted small mono">${p.parcel_id}</span> ${p.active ? '' : html`<span class="badge">inactive</span>`}
        ${p.ends_at ? html`<span class="muted small">until ${new Date(p.ends_at).toLocaleDateString()}</span>` : ''}
        <button class="btn small" data-action="promo-toggle" data-id="${p.id}" data-active="${p.active ? '0' : '1'}">${p.active ? 'Take down' : 'Re-post'}</button>
      </li>`,
    )}</ul>`;
}

function stationUrl(token: string): string {
  return new URL(`#/qr/${token}`, location.href.split('#')[0]).toString();
}

async function stations(): Promise<Raw> {
  const rows = await api<any[]>('GET', '/admin/qr');
  return html`
    <form class="form card" data-form="qr">
      <h3>New QR refill station</h3>
      <p class="muted small">Print the code and post it at the business. A player who scans it while standing in that parcel gets a free Flare, once per station per day.</p>
      ${locationFields()}
      <label>Name<input name="name" class="text-input" required maxlength="80" placeholder="Sagebrush Coffee counter"></label>
      <button class="btn primary" type="submit">Create station</button>
    </form>
    <ul class="admin-list">${rows.map(
      (s) => html`<li>
        <b>${s.name}</b> <span class="muted small mono">${s.parcel_id}</span> · ${s.redemptions} scans ${s.active ? '' : html`<span class="badge">inactive</span>`}
        <div class="row-btns">
          <button class="btn small" data-action="qr-print" data-token="${s.token}" data-name="${s.name}" data-parcel="${s.parcel_id}">Print code</button>
          <button class="btn small" data-action="qr-toggle" data-id="${s.id}" data-active="${s.active ? '0' : '1'}">${s.active ? 'Disable' : 'Enable'}</button>
        </div>
      </li>`,
    )}</ul>`;
}

function printQr(token: string, name: string, parcel: string) {
  const url = stationUrl(token);
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  const svg = qr.createSvgTag({ cellSize: 8, margin: 2, scalable: true });
  const w = window.open('', '_blank');
  if (!w) {
    toast('Allow pop-ups to print the code.', 'bad');
    return;
  }
  const safeName = escapeHtml(name);
  w.document.write(`<!doctype html><meta charset="utf-8"><title>${safeName}</title>
    <style>body{font-family:system-ui,sans-serif;text-align:center;padding:24px}svg{width:min(80vw,420px);height:auto}h1{margin:.2em 0}p{color:#444}</style>
    <h1>Free Flare!</h1><p>Scan with your phone's camera while you're here at <b>${safeName}</b>.</p>${svg}
    <p style="font-size:12px">Parcel ${escapeHtml(parcel)} · once per player per day<br>${escapeHtml(url)}</p><script>setTimeout(()=>print(),300)</script>`);
  w.document.close();
}

