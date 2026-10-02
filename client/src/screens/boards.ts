import { CONFIG } from '../../../shared/config.ts';
import type { BoardKey, BoardResult } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { state } from '../state.ts';
import { actions, openSheet, setSheetBody, sheetBody } from '../ui.ts';
import { html, money, storage, store } from '../util.ts';

const BOARDS: { key: BoardKey; name: string; what: string; money: boolean }[] = [
  { key: 'money', name: 'Most Money', what: 'Cash on hand', money: true },
  { key: 'parcels', name: 'Most Land Parcels', what: 'Parcels owned', money: false },
  { key: 'expensive', name: 'Most Expensive Land', what: 'Highest max price of one parcel', money: true },
  { key: 'land_value', name: 'Total Land Value', what: 'Sum of max prices of all parcels', money: true },
  { key: 'shop_keep', name: 'Shop Keep', what: 'Lifetime store proceeds and business rent', money: true },
  { key: 'spectral_thief', name: 'Spectral Thief', what: 'Lifetime money taken by Spooks', money: true },
];

let board: BoardKey = storage<BoardKey>('board', 'money');
let scope: 'global' | 'local' = storage<'global' | 'local'>('scope', 'global');

export function showBoards() {
  openSheet({ title: 'Leaderboards', body: html`<div class="loading">Tallying...</div>`, className: 'boards-sheet' });
  actions(sheetBody()!, {
    board: (el) => {
      board = el.dataset.key as BoardKey;
      store('board', board);
      load();
    },
    scope: (el) => {
      scope = el.dataset.scope as 'global' | 'local';
      store('scope', scope);
      load();
    },
  });
  load();
}

async function load() {
  const meta = BOARDS.find((b) => b.key === board) ?? BOARDS[0]!;
  const f = state.fix;
  const q = new URLSearchParams({ scope });
  if (scope === 'local' && f) {
    q.set('lat', String(f.lat));
    q.set('lng', String(f.lng));
  }
  let r: BoardResult | null = null;
  let error = '';
  try {
    r = await api<BoardResult>('GET', `/leaderboards/${board}?${q}`);
  } catch (err) {
    error = (err as Error).message;
  }
  if (!sheetBody()) return;
  const fmt = (v: number) => (meta.money ? money(v) : v.toLocaleString('en-US'));
  const myId = state.me?.id;
  setSheetBody(html`
    <div class="chips">${BOARDS.map(
      (b) => html`<button class="chip ${b.key === board ? 'on' : ''}" data-action="board" data-key="${b.key}">${b.name}</button>`,
    )}</div>
    <div class="seg">
      <button class="${scope === 'global' ? 'on' : ''}" data-action="scope" data-scope="global">Global</button>
      <button class="${scope === 'local' ? 'on' : ''}" data-action="scope" data-scope="local">Local · ${CONFIG.LOCAL_BOARD_KM} km</button>
    </div>
    <p class="muted small">${meta.what}. Boards are rebuilt once a night${r?.date ? ` (last: ${r.date})` : ''}.</p>
    ${error ? html`<p class="error">${error}</p>` : ''}
    ${r && !r.date ? html`<p class="muted">The first boards appear after tonight's tally.</p>` : ''}
    ${r && r.date && scope === 'local' && !f && !state.me?.lastFix ? html`<p class="muted">Share your location to see players near you.</p>` : ''}
    ${r && r.rows.length
      ? html`<ol class="board">${r.rows.map(
          (row) => html`<li class="${row.userId === myId ? 'me' : ''}"><span class="rank">${row.rank}</span><span class="who">${row.username}</span><span class="val">${fmt(row.value)}</span></li>`,
        )}</ol>`
      : r?.date
        ? html`<p class="muted">Nobody on this board yet.</p>`
        : ''}
    ${r?.me && !r.rows.some((x) => x.userId === r!.me!.userId)
      ? html`<ol class="board"><li class="me"><span class="rank">${r.me.rank}</span><span class="who">${r.me.username}</span><span class="val">${fmt(r.me.value)}</span></li></ol>`
      : ''}
  `);
}
