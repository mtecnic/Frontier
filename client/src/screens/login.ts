import { startAuthentication } from '@simplewebauthn/browser';
import { CONFIG } from '../../../shared/config.ts';
import type { Me } from '../../../shared/types.ts';
import { api, ApiError, setToken } from '../api.ts';
import { ART } from '../art.ts';
import { markOpen } from '../geo.ts';
import { setMe, state } from '../state.ts';
import { actions, busy, closeSheet, guide, openSheet, setSheetBody, sheetBody, toast } from '../ui.ts';
import { html } from '../util.ts';

let requestId: number | null = null;
let email = '';
let signupToken = '';
let afterLogin: (() => void) | null = null;

/** Run fn once the player is signed in (immediately if they already are). */
export function requireLogin(fn: () => void) {
  if (state.signedIn) fn();
  else {
    afterLogin = fn;
    location.hash = '#/login';
  }
}

function signedIn(me: Me, token?: string) {
  setToken(token);
  setMe(me);
  toast(`Welcome, ${me.username}!`, 'good');
  closeSheet();
  history.replaceState(null, '', '#/');
  markOpen();
  const next = afterLogin;
  afterLogin = null;
  next?.();
}

export function showLogin(params: URLSearchParams) {
  if (state.signedIn) {
    location.hash = '#/me';
    return;
  }
  openSheet({ title: 'Sign in', body: html`<div class="loading">One moment...</div>`, className: 'login-sheet' });
  const token = params.get('token');
  if (token) {
    verify({ token });
    return;
  }
  stepEmail();
}

function stepEmail() {
  setSheetBody(html`
    ${guide(
      html`Howdy! I'm ${CONFIG.GUIDE_NAME} from the Land Office. Give me your email and I'll send a sign-in code. No passwords out here.`,
      ART.mabel,
    )}
    <form class="form" data-form="email">
      <label>Email<input type="email" name="email" autocomplete="email" required value="${email}" placeholder="you@example.com"></label>
      <button class="btn primary wide" type="submit">Email me a code</button>
    </form>
    ${state.features.passkeys && 'PublicKeyCredential' in window
      ? html`<div class="or">or</div><button class="btn wide" data-action="passkey">Sign in with a passkey</button>`
      : ''}
    <p class="muted small">New here? The same code creates your account. You start with ${'$' + CONFIG.START_CASH_CENTS / 100}, ${CONFIG.START_SPOOKS} Spook and ${CONFIG.START_FLARES} Flares.</p>
  `);
  const body = sheetBody()!;
  const form = body.querySelector('form')!;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const btn = form.querySelector('button')!;
    busy(btn, async () => {
      email = String(new FormData(form).get('email') ?? '').trim();
      const r = await api<{ requestId: number; devCode?: string }>('POST', '/auth/link', { email });
      requestId = r.requestId;
      stepCode(r.devCode);
    });
  });
  actions(body, { passkey: (el) => busy(el, passkeyLogin) });
  (form.querySelector('input') as HTMLInputElement).focus();
}

function stepCode(devCode?: string) {
  setSheetBody(html`
    ${guide(html`I sent a 6-digit code to <b>${email}</b>. Type it here, or tap the link in the email on this device.`, ART.mabel)}
    <form class="form" data-form="code">
      <label>Code<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" maxlength="7" required class="code-input" value="${devCode ?? ''}"></label>
      <button class="btn primary wide" type="submit">Sign in</button>
    </form>
    ${devCode ? html`<p class="muted small">Development mode: the code was filled in for you.</p>` : ''}
    <button class="btn link" data-action="back">Use a different email</button>
  `);
  const body = sheetBody()!;
  const form = body.querySelector('form')!;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = String(new FormData(form).get('code') ?? '').replace(/\D/g, '');
    busy(form.querySelector('button'), () => verify({ requestId, code }));
  });
  actions(body, { back: () => stepEmail() });
  (form.querySelector('input') as HTMLInputElement).focus();
}

async function verify(body: Record<string, unknown>) {
  try {
    const r = await api<{ me?: Me; token?: string; needsUsername?: boolean; signupToken?: string; email?: string }>('POST', '/auth/verify', body);
    if (r.needsUsername) {
      signupToken = r.signupToken!;
      email = r.email ?? email;
      stepUsername();
    } else if (r.me) signedIn(r.me, r.token);
  } catch (err) {
    if (err instanceof ApiError && body.token) {
      setSheetBody(html`<p class="error">${err.message}</p>`);
      setTimeout(stepEmail, 2500);
      return;
    }
    throw err;
  }
}

function stepUsername() {
  setSheetBody(html`
    ${guide(
      html`Welcome to the frontier! Pick the name other players will see on your deeds: ${CONFIG.USERNAME_MIN}-${CONFIG.USERNAME_MAX} letters, numbers, _ or -.`,
      ART.mabel,
    )}
    <form class="form">
      <label>Username<input name="username" autocomplete="username" minlength="${CONFIG.USERNAME_MIN}" maxlength="${CONFIG.USERNAME_MAX}" pattern="[A-Za-z0-9_\\-]+" required></label>
      <button class="btn primary wide" type="submit">Stake my first claim</button>
    </form>
  `);
  const form = sheetBody()!.querySelector('form')!;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form.querySelector('button'), async () => {
      const username = String(new FormData(form).get('username') ?? '').trim();
      const r = await api<{ me: Me; token?: string }>('POST', '/auth/signup', { signupToken, username });
      signedIn(r.me, r.token);
    });
  });
  (form.querySelector('input') as HTMLInputElement).focus();
}

async function passkeyLogin() {
  const { challengeId, options } = await api('POST', '/auth/passkey/login/options', {});
  let response;
  try {
    response = await startAuthentication({ optionsJSON: options });
  } catch (err) {
    toast('Passkey sign-in was cancelled.', 'info');
    return;
  }
  const r = await api<{ me: Me; token?: string }>('POST', '/auth/passkey/login/verify', { challengeId, response });
  signedIn(r.me, r.token);
}

