import { CONFIG } from '../../shared/config.ts';
import { cellIdOf } from '../../shared/grid.ts';
import { ART, ICON } from './art.ts';
import { startWatching } from './geo.ts';
import { centerOnFix, setFollow } from './map.ts';
import { on, serverNow, state } from './state.ts';
import { $, dollars, duration, html, money, moneySmart, raw } from './util.ts';

let wakeLock: WakeLockSentinel | null = null;

export function mountHud() {
  $('#hud-top').innerHTML = html`
    <a class="cash-pill" href="#/me" aria-label="Cash">
      <span class="coin">${raw(ART.coin)}</span>
      <span><b id="hud-cash">—</b><small id="hud-income"></small></span>
    </a>
    <a class="inv-pill" href="#/office" aria-label="Inventory">
      <span title="Lawyers">${raw(ART.lawyer)}<b id="inv-lawyers">0</b></span>
      <span title="Spooks">${raw(ART.ghost)}<b id="inv-spooks">0</b></span>
      <span title="Flares">${raw(ART.flare)}<b id="inv-flares">0</b></span>
    </a>
    <button class="gps-pill" id="gps-pill" aria-label="GPS status"><span class="dot"></span><span id="gps-text">GPS</span></button>
  `.html;

  $('#fabs').innerHTML = html`
    <button class="fab" id="fab-follow" aria-label="Follow me" title="Follow me (Chase)">${raw(ICON.follow)}</button>
    <button class="fab" id="fab-wake" aria-label="Keep screen awake" title="Keep screen awake">${raw(ICON.sun)}</button>
    <a class="fab" href="#/help" aria-label="Help" title="Help">${raw(ICON.help)}</a>
  `.html;

  $('#nav').innerHTML = html`
    <a href="#/me" class="nav-btn">${raw(ICON.me)}<span>Me</span></a>
    <a href="#/office" class="nav-btn">${raw(ICON.office)}<span>Office</span></a>
    <button id="here-btn" class="here-btn"><span class="here-top" id="here-top">Find me</span><span class="here-sub" id="here-sub">tap to start GPS</span></button>
    <a href="#/prizes" class="nav-btn">${raw(ART.nugget)}<span>Prizes</span></a>
    <a href="#/more" class="nav-btn">${raw(ICON.more)}<span>More</span></a>
  `.html;

  $('#fab-follow').addEventListener('click', () => {
    if (!state.fix) {
      startWatching();
      setFollow(true);
      return;
    }
    if (state.follow) centerOnFix();
    setFollow(!state.follow);
  });
  $('#fab-wake').addEventListener('click', () => {
    state.wake = !state.wake;
    try {
      localStorage.setItem('frontier:wake', JSON.stringify(state.wake));
    } catch {
      /* ignore */
    }
    syncWake();
  });
  $('#gps-pill').addEventListener('click', () => {
    if (!state.fix) startWatching();
    else {
      setFollow(true);
      centerOnFix();
    }
  });
  $('#here-btn').addEventListener('click', () => {
    if (!state.fix) {
      startWatching();
      setFollow(true);
      return;
    }
    centerOnFix();
    location.hash = `#/parcel/${cellIdOf(state.fix.lat, state.fix.lng)}`;
  });

  on('me', updateTop);
  on('fix', () => {
    updateGps();
    updateHere();
  });
  on('server-fix', updateGps);
  on('parcels', updateHere);
  on('me', updateHere);
  on('follow', () => {
    updateFollow();
    syncWake();
  });
  on('online', updateGps);
  document.addEventListener('frontier:wake', syncWake);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncWake();
  });
  setInterval(updateHere, 30_000);
  updateTop();
  updateGps();
  updateHere();
  updateFollow();
}

function updateTop() {
  const me = state.me;
  $('#hud-cash').textContent = me ? money(me.cashCents) : 'Sign in';
  $('#hud-income').textContent = me ? ` +${moneySmart(me.hourlyIncomeCents)}/h` : '';
  $('#inv-lawyers').textContent = String(me?.inventory.lawyers ?? 0);
  $('#inv-spooks').textContent = String(me?.inventory.spooks ?? 0);
  $('#inv-flares').textContent = String(me?.inventory.flares ?? 0);
  document.body.classList.toggle('signed-in', !!me);
}

function updateGps() {
  const pill = $('#gps-pill');
  const text = $('#gps-text');
  pill.className = 'gps-pill';
  if (!state.online) {
    pill.classList.add('bad');
    text.textContent = 'Offline';
    return;
  }
  const f = state.fix;
  if (!f) {
    pill.classList.add(state.fixError ? 'bad' : 'idle');
    text.textContent = state.fixError ? 'No GPS' : 'GPS off';
    pill.title = state.fixError ?? 'Tap to start GPS';
    return;
  }
  const acc = Math.round(f.accuracy);
  const sf = state.serverFix;
  if (acc > CONFIG.MAX_ACCURACY_M) {
    pill.classList.add('warn');
    pill.title = `Accuracy ±${acc} m. Buying needs ±${CONFIG.MAX_ACCURACY_M} m or better.`;
  } else if (sf && sf.status !== 'accepted' && Date.now() - sf.at < 120_000) {
    pill.classList.add('warn');
    pill.title = sf.message ?? 'Location not accepted';
  } else {
    pill.classList.add('good');
    pill.title = `Accuracy ±${acc} m`;
  }
  text.textContent = `±${acc} m`;
}

function updateFollow() {
  $('#fab-follow').classList.toggle('on', state.follow);
  $('#fab-wake').classList.toggle('hidden', !state.follow || !('wakeLock' in navigator));
  $('#fab-wake').classList.toggle('on', state.wake);
}

async function syncWake() {
  updateFollow();
  const want = state.follow && state.wake && document.visibilityState === 'visible';
  try {
    if (want && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
    } else if (!want && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    wakeLock = null;
  }
}

/** The big center button: what you can do on the parcel you're standing in. */
function updateHere() {
  const top = $('#here-top');
  const sub = $('#here-sub');
  const btn = $('#here-btn');
  btn.className = 'here-btn';
  const f = state.fix;
  if (!f) {
    top.textContent = state.fixError ? 'No GPS' : 'Find me';
    sub.textContent = state.fixError ? 'location blocked' : 'tap to start GPS';
    btn.classList.add('idle');
    return;
  }
  const id = cellIdOf(f.lat, f.lng);
  const p = state.parcels.get(id);
  const me = state.me;
  if (f.accuracy > CONFIG.MAX_ACCURACY_M) {
    top.textContent = `GPS ±${Math.round(f.accuracy)} m`;
    sub.textContent = 'waiting for accuracy';
    btn.classList.add('warn');
    return;
  }
  if (!p) {
    top.textContent = `Buy ${dollars(CONFIG.UNOWNED_PRICE)}`;
    sub.textContent = me ? 'open land here' : 'sign in to claim';
    btn.classList.add('go');
    return;
  }
  if (me && p.ownerId === me.id) {
    top.textContent = 'Yours';
    sub.textContent = `worth ${dollars(p.price)}`;
    btn.classList.add('mine');
    return;
  }
  const lockLeft = p.lockedUntil ? Date.parse(p.lockedUntil) - serverNow() : 0;
  if (lockLeft > 0) {
    top.textContent = `Locked`;
    sub.textContent = `${duration(lockLeft)} · ${p.owner}`;
    btn.classList.add('locked');
    return;
  }
  top.textContent = `Jump ${dollars(p.price)}`;
  sub.textContent = `${p.owner}'s land${p.spook ? ' · spooked!' : ''}`;
  btn.classList.add('jump');
}
