import { ApiError } from './api.ts';
import { ICON } from './art.ts';
import { html, raw, type Raw } from './util.ts';

let sheetOnClose: (() => void) | null = null;

/** Bottom sheet on phones, side panel on wide screens. One at a time. */
export function openSheet(opts: { title: string | Raw; body: Raw | string; className?: string; onClose?: () => void }): HTMLElement {
  const sheet = document.getElementById('sheet')!;
  sheetOnClose?.();
  sheetOnClose = opts.onClose ?? null;
  sheet.className = `sheet open ${opts.className ?? ''}`;
  sheet.innerHTML = html`
    <header class="sheet-head">
      <h2>${opts.title}</h2>
      <button class="icon-btn" data-close aria-label="Close">${raw(ICON.close)}</button>
    </header>
    <div class="sheet-body">${typeof opts.body === 'string' ? raw(opts.body) : opts.body}</div>`.html;
  sheet.querySelector('[data-close]')!.addEventListener('click', () => closeSheet(true));
  document.body.classList.add('sheet-open');
  (sheet.querySelector('.sheet-body') as HTMLElement).scrollTop = 0;
  requestAnimationFrame(() => document.dispatchEvent(new CustomEvent('frontier:sheet')));
  return sheet.querySelector('.sheet-body') as HTMLElement;
}

export function sheetBody(): HTMLElement | null {
  const sheet = document.getElementById('sheet')!;
  return sheet.classList.contains('open') ? (sheet.querySelector('.sheet-body') as HTMLElement) : null;
}

export function closeSheet(navigate = false) {
  const sheet = document.getElementById('sheet')!;
  sheet.className = 'sheet';
  sheet.innerHTML = '';
  document.body.classList.remove('sheet-open');
  document.dispatchEvent(new CustomEvent('frontier:sheet'));
  const cb = sheetOnClose;
  sheetOnClose = null;
  cb?.();
  if (navigate && location.hash && location.hash !== '#/') history.pushState(null, '', '#/');
}

export function setSheetBody(content: Raw | string) {
  const b = sheetBody();
  if (b) b.innerHTML = typeof content === 'string' ? content : content.html;
}

export function toast(message: string, kind: 'info' | 'good' | 'bad' | 'gold' = 'info', ms = 4000) {
  const host = document.getElementById('toasts')!;
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', 'status');
  el.textContent = message;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  const remove = () => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  };
  el.addEventListener('click', remove);
  setTimeout(remove, ms);
}

export function errorToast(err: unknown) {
  if (err instanceof ApiError) toast(err.message, 'bad', 5000);
  else toast((err as Error)?.message ?? 'Something went wrong.', 'bad', 5000);
}

export interface DialogAction {
  label: string;
  value: string;
  kind?: 'primary' | 'danger' | 'plain';
}

/** Modal dialog; resolves with the chosen action's value (or 'cancel'). */
export function dialog(opts: { title: string; body: Raw | string; actions?: DialogAction[]; className?: string }): Promise<string> {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    const actions = opts.actions ?? [{ label: 'OK', value: 'ok', kind: 'primary' }];
    wrap.innerHTML = html`
      <div class="modal ${opts.className ?? ''}" role="dialog" aria-modal="true">
        <h2>${opts.title}</h2>
        <div class="modal-body">${typeof opts.body === 'string' ? raw(opts.body) : opts.body}</div>
        <div class="modal-actions">
          ${actions.map((a) => html`<button class="btn ${a.kind ?? 'plain'}" data-v="${a.value}">${a.label}</button>`)}
        </div>
      </div>`.html;
    document.body.appendChild(wrap);
    requestAnimationFrame(() => wrap.classList.add('show'));
    const done = (v: string) => {
      wrap.classList.remove('show');
      setTimeout(() => wrap.remove(), 200);
      resolve(v);
    };
    wrap.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('[data-v]') as HTMLElement | null;
      if (b) done(b.dataset.v!);
      else if (e.target === wrap) done('cancel');
    });
    (wrap.querySelector('.btn.primary, .btn') as HTMLElement | null)?.focus();
  });
}

/** Run an async action with the button disabled and a spinner. */
export async function busy<T>(btn: HTMLElement | null, fn: () => Promise<T>): Promise<T | undefined> {
  if (btn?.hasAttribute('disabled')) return undefined;
  const label = btn?.innerHTML;
  btn?.setAttribute('disabled', '');
  btn?.classList.add('busy');
  try {
    return await fn();
  } catch (err) {
    errorToast(err);
    return undefined;
  } finally {
    if (btn && btn.isConnected) {
      btn.removeAttribute('disabled');
      btn.classList.remove('busy');
      if (label != null) btn.innerHTML = label;
    }
  }
}

/** Delegate clicks on [data-action] inside root to handlers. */
export function actions(root: HTMLElement, map: Record<string, (el: HTMLElement, ev: Event) => void | Promise<void>>) {
  root.addEventListener('click', (ev) => {
    const el = (ev.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
    if (!el || !root.contains(el)) return;
    const fn = map[el.dataset.action!];
    if (fn) {
      ev.preventDefault();
      fn(el, ev);
    }
  });
}

export function guide(text: Raw | string, art: string): Raw {
  return html`<div class="guide"><div class="guide-face">${raw(art)}</div><div class="guide-says">${typeof text === 'string' ? text : text}</div></div>`;
}
