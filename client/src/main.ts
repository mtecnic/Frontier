import { applyConfig } from '../../shared/config.ts';
import type { CheckinResult, Me, Summary } from '../../shared/types.ts';
import { api, ApiError } from './api.ts';
import { markOpen, onCheckin, startWatching } from './geo.ts';
import { mountHud } from './hud.ts';
import { initMap, refreshParcels } from './map.ts';
import { resyncPush } from './push.ts';
import { emit, noteServerTime, on, setMe, state } from './state.ts';
import { closeSheet, errorToast, toast } from './ui.ts';
import { dollars, money } from './util.ts';
import { showAdmin } from './screens/admin.ts';
import { showBoards } from './screens/boards.ts';
import { intro, showHelp } from './screens/help.ts';
import { showLogin } from './screens/login.ts';
import { showMe } from './screens/me.ts';
import { showMore } from './screens/more.ts';
import { showPrizes, showPromotions } from './screens/nearby.ts';
import { showOffice } from './screens/office.ts';
import { showParcel } from './screens/parcel.ts';
import { redeemQrLink } from './screens/qr.ts';
import { showSummary } from './screens/summary.ts';

declare const __BUILD__: string;

// ---- Router (hash-based, so the app works from any static folder) ----

function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [path = '', query = ''] = hash.split('?');
  const params = new URLSearchParams(query);
  const [head, ...rest] = path.split('/');
  try {
    switch (head) {
      case '':
        closeSheet();
        break;
      case 'parcel':
        showParcel(decodeURIComponent(rest.join('/')));
        break;
      case 'me':
        showMe();
        break;
      case 'office':
        showOffice();
        break;
      case 'prizes':
        showPrizes();
        break;
      case 'promos':
        showPromotions().catch(errorToast);
        break;
      case 'boards':
        showBoards();
        break;
      case 'help':
        showHelp();
        break;
      case 'more':
        showMore();
        break;
      case 'admin':
        showAdmin();
        break;
      case 'login':
        showLogin(params);
        break;
      case 'qr':
        redeemQrLink(rest.join('/'));
        break;
      default:
        closeSheet();
    }
  } catch (err) {
    errorToast(err);
  }
}

// ---- Check-in side effects ----

function handleCheckin(r: CheckinResult) {
  for (const p of r.prizes) {
    toast(p.kind === 'lawyer' ? 'You found a prize: a free Lawyer!' : `You found a gold nugget worth ${money(p.amountCents)}!`, 'gold', 6000);
    navigator.vibrate?.([80, 60, 80]);
  }
  if (r.prizes.length) refreshParcels();
  if (r.visited && r.visited.previousPrice < r.visited.price) {
    toast(`Owner visit: parcel ${r.visited.parcelId} is back up to ${dollars(r.visited.price)}.`, 'good', 3000);
    refreshParcels();
  }
  if (r.newLogin && r.summary) showSummary(r.summary);
}

// ---- Boot ----

async function boot() {
  window.addEventListener('online', () => {
    state.online = true;
    emit('online');
    markOpen();
  });
  window.addEventListener('offline', () => {
    state.online = false;
    emit('online');
    toast("You're offline. Buying needs a connection.", 'bad');
  });

  mountHud();
  onCheckin(handleCheckin);

  try {
    const cfg = await api<{ config: Record<string, unknown>; vapidPublicKey: string; features: typeof state.features; serverTime: string }>(
      'GET',
      '/config',
    );
    applyConfig(cfg.config);
    state.vapidKey = cfg.vapidPublicKey;
    state.features = cfg.features;
    noteServerTime(cfg.serverTime);
  } catch (err) {
    toast(err instanceof ApiError ? err.message : "Couldn't reach the game server.", 'bad', 8000);
  }

  try {
    const r = await api<{ me: Me; summary: Summary }>('GET', '/me');
    setMe(r.me);
    resyncPush();
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 401)) console.warn(err);
    setMe(null);
  }

  await initMap(document.getElementById('map')!, (id) => {
    location.hash = `#/parcel/${id}`;
  });
  state.booted = true;
  document.body.classList.add('ready');

  window.addEventListener('hashchange', route);
  route();

  // Location: start straight away if already allowed, otherwise after the welcome tour.
  let granted = false;
  try {
    granted = (await navigator.permissions?.query({ name: 'geolocation' }))?.state === 'granted';
  } catch {
    /* Safari without the Permissions API */
  }
  if (granted) startWatching();
  else if (!location.hash.startsWith('#/qr') && !location.hash.startsWith('#/login')) {
    await intro();
    startWatching();
  }
  on('auth', () => {
    if (state.signedIn) markOpen();
  });
  markOpen();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker
    .register(`./sw.js?v=${__BUILD__}`)
    .then((reg) => {
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller)
            toast('A new version is ready. It loads next time you open the app.', 'info', 6000);
        });
      });
    })
    .catch((err) => console.warn('Service worker registration failed', err));
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'navigate' && typeof e.data.url === 'string') location.hash = e.data.url.replace(/^.*#/, '#');
  });
}

registerServiceWorker();
boot().catch((err) => {
  console.error(err);
  toast('Something went wrong starting the game. Try reloading.', 'bad', 10000);
});
