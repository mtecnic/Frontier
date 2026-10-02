import { cellIdOf, haversineKm } from '../../shared/grid.ts';
import type { CheckinResult, Fix } from '../../shared/types.ts';
import { api, ApiError } from './api.ts';
import { emit, noteServerTime, setMe, state, type LocalFix } from './state.ts';

let watchId: number | null = null;
let lastSent: { lat: number; lng: number; cell: string; at: number } | null = null;
let sending = false;
let pendingOpen = true;
const handlers: ((r: CheckinResult) => void)[] = [];

/** Subscribe to every check-in result (prizes, visits, summary...). */
export function onCheckin(fn: (r: CheckinResult) => void) {
  handlers.push(fn);
}

export function toApiFix(f: LocalFix): Fix {
  return { lat: f.lat, lng: f.lng, accuracy: f.accuracy, timestamp: f.timestamp, sentAt: Date.now() };
}

function onPosition(p: GeolocationPosition) {
  state.fix = {
    lat: p.coords.latitude,
    lng: p.coords.longitude,
    accuracy: p.coords.accuracy,
    timestamp: p.timestamp,
    heading: p.coords.heading,
  };
  state.fixError = null;
  emit('fix');
  maybeCheckin();
}

function onError(err: GeolocationPositionError) {
  state.fixError =
    err.code === err.PERMISSION_DENIED
      ? 'Location is blocked. Allow it in your browser settings to play.'
      : err.code === err.TIMEOUT
        ? 'Still looking for a GPS fix...'
        : 'Location unavailable right now.';
  emit('fix');
  if (err.code === err.PERMISSION_DENIED) stopWatching();
}

export function startWatching() {
  if (!('geolocation' in navigator)) {
    state.fixError = "This browser can't share your location.";
    emit('fix');
    return;
  }
  if (watchId != null) return;
  watchId = navigator.geolocation.watchPosition(onPosition, onError, {
    enableHighAccuracy: true,
    maximumAge: 3000,
    timeout: 30000,
  });
}

export function stopWatching() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}

/** A fix no older than maxAgeMs, asking the GPS for a new one if needed. */
export function freshFix(maxAgeMs = 15000): Promise<LocalFix | null> {
  const f = state.fix;
  if (f && Date.now() - f.timestamp < maxAgeMs) return Promise.resolve(f);
  if (!('geolocation' in navigator)) return Promise.resolve(f);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => {
        onPosition(p);
        resolve(state.fix);
      },
      () => resolve(state.fix),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 12000 },
    );
  });
}

/** Mark the next check-in as an "app open" even without movement. */
export function markOpen() {
  pendingOpen = true;
  maybeCheckin();
}

function shouldSend(): boolean {
  if (!state.signedIn || sending || !state.online) return false;
  const f = state.fix;
  const now = Date.now();
  if (pendingOpen) return true;
  if (!f) return false;
  if (!lastSent) return true;
  if (now - lastSent.at < 5000) return false;
  const cell = cellIdOf(f.lat, f.lng);
  if (cell !== lastSent.cell) return true;
  if (haversineKm(f.lat, f.lng, lastSent.lat, lastSent.lng) > 0.04) return true;
  return now - lastSent.at > 60_000;
}

export async function maybeCheckin(force = false): Promise<CheckinResult | null> {
  if (!force && !shouldSend()) return null;
  if (!state.signedIn || sending) return null;
  sending = true;
  const f = state.fix && Date.now() - state.fix.timestamp < 25_000 ? state.fix : null;
  pendingOpen = false;
  try {
    const r = await api<CheckinResult>('POST', '/checkin', { fix: f ? toApiFix(f) : null });
    noteServerTime(r.serverTime);
    if (f) lastSent = { lat: f.lat, lng: f.lng, cell: cellIdOf(f.lat, f.lng), at: Date.now() };
    state.serverFix = f ? { status: r.fix, message: r.fixMessage, cellId: r.cellId, at: Date.now() } : state.serverFix;
    setMe(r.me);
    emit('server-fix');
    handlers.forEach((h) => h(r));
    return r;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) setMe(null);
    return null;
  } finally {
    sending = false;
  }
}

// Keep trying periodically (covers "60 s elapsed" and fixes arriving while a request was in flight).
setInterval(() => {
  if (document.visibilityState === 'visible') maybeCheckin();
}, 10_000);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') markOpen();
});
