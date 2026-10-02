import type pg from 'pg';
import { CONFIG, DAY_MS, HOUR_MS, MINUTE_MS } from '../shared/config.ts';
import { cellIdOf, haversineKm } from '../shared/grid.ts';
import type { Fix, FixStatus } from '../shared/types.ts';
import type { UserRow } from './economy.ts';
import { raiseFlag } from './flags.ts';

export interface FixCheck {
  status: FixStatus;
  message?: string;
  fix?: Fix;
  cellId?: string;
}

/** Shape-check a fix from the request body. Returns null when absent. */
export function parseFix(raw: unknown): Fix | null {
  if (raw == null) return null;
  if (typeof raw !== 'object') return null;
  const f = raw as Record<string, unknown>;
  const n = (k: string) => (typeof f[k] === 'number' && Number.isFinite(f[k]) ? (f[k] as number) : NaN);
  const fix: Fix = {
    lat: n('lat'),
    lng: n('lng'),
    accuracy: n('accuracy'),
    timestamp: n('timestamp'),
    sentAt: n('sentAt'),
    serverTimestamp: n('serverTimestamp'),
  };
  if (
    !(fix.lat >= -90 && fix.lat <= 90) ||
    !(fix.lng >= -180 && fix.lng < 180) ||
    !(fix.accuracy >= 0) ||
    !(fix.timestamp > 0) ||
    !(fix.sentAt > 0) ||
    !(fix.serverTimestamp > 0)
  ) {
    return { ...fix, accuracy: NaN };
  }
  return fix;
}

/**
 * Decide whether to trust a fix: recent, accurate and physically plausible from
 * the previous verified fix. Logs every fix. On acceptance, stores it as the
 * user's last verified fix. Caller holds the user's row lock and passes the row.
 */
export async function verifyFix(c: pg.PoolClient, user: UserRow, fix: Fix, now: number): Promise<FixCheck> {
  let status: FixStatus = 'accepted';
  let message: string | undefined;

  if (!Number.isFinite(fix.accuracy) || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lng)) {
    status = 'invalid';
    message = 'That location fix was malformed.';
  } else if (fix.accuracy > CONFIG.MAX_ACCURACY_M) {
    status = 'inaccurate';
    message = `GPS accuracy is ±${Math.round(fix.accuracy)} m; it needs to be ${CONFIG.MAX_ACCURACY_M} m or better.`;
  } else {
    // Age on the device's own clock (works even if the phone's clock is wrong) ...
    const age = (fix.sentAt - fix.timestamp) / 1000;
    // ... and against the server clock, via the offset the client learned from us, so an old
    // request replayed later is refused. A few seconds of slack cover latency.
    const serverAge = (now - fix.serverTimestamp) / 1000;
    if (age > CONFIG.MAX_FIX_AGE_S || age < -5 || serverAge > CONFIG.MAX_FIX_AGE_S + 10 || serverAge < -15) {
      status = 'stale';
      message = 'That location fix is too old. Waiting for a fresh one.';
    } else if (user.last_fix_at && user.last_fix_lat != null && user.last_fix_lng != null) {
      const dtMs = Math.max(1, now - user.last_fix_at.getTime());
      const rawKm = haversineKm(user.last_fix_lat, user.last_fix_lng, fix.lat, fix.lng);
      // GPS jitter: allow both fixes' error radii before counting distance.
      const km = Math.max(0, rawKm - ((user.last_fix_acc ?? 0) + fix.accuracy) / 1000);
      const kmh = km / (dtMs / HOUR_MS);
      const limit = dtMs > CONFIG.FLIGHT_GAP_MIN * MINUTE_MS ? CONFIG.FLIGHT_SPEED_KMH : CONFIG.MAX_SPEED_KMH;
      if (kmh > limit) {
        status = 'too_fast';
        message = `You appear to have moved ${rawKm.toFixed(1)} km too quickly. Location not accepted.`;
      }
    }
  }

  await c.query(
    'INSERT INTO fix_log (user_id, time, lat, lng, accuracy, accepted, reason) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [
      user.id,
      new Date(now),
      Number.isFinite(fix.lat) ? fix.lat : null,
      Number.isFinite(fix.lng) ? fix.lng : null,
      Number.isFinite(fix.accuracy) ? fix.accuracy : null,
      status === 'accepted',
      status === 'accepted' ? null : status,
    ],
  );

  if (status !== 'accepted') return { status, message, fix };

  await c.query(
    'UPDATE users SET last_fix_lat = $2, last_fix_lng = $3, last_fix_at = $4, last_fix_acc = $5 WHERE id = $1',
    [user.id, fix.lat, fix.lng, new Date(now), fix.accuracy],
  );
  user.last_fix_lat = fix.lat;
  user.last_fix_lng = fix.lng;
  user.last_fix_at = new Date(now);
  user.last_fix_acc = fix.accuracy;

  await checkSpoofPattern(c, user.id, now);
  return { status, fix, cellId: cellIdOf(fix.lat, fix.lng) };
}

/** Flag (never block) a long run of fixes reporting the exact same accuracy while moving across cells. */
async function checkSpoofPattern(c: pg.PoolClient, userId: number, now: number) {
  const run = CONFIG.FLAG_SAME_ACCURACY_RUN;
  const rows = await c.query<{ lat: number; lng: number; accuracy: number }>(
    `SELECT lat, lng, accuracy FROM fix_log WHERE user_id = $1 AND accepted ORDER BY time DESC LIMIT $2`,
    [userId, run],
  );
  if (rows.rows.length < run) return;
  const acc = rows.rows[0]!.accuracy;
  if (!rows.rows.every((r) => r.accuracy === acc)) return;
  const cells = new Set(rows.rows.map((r) => cellIdOf(r.lat, r.lng)));
  if (cells.size < 5) return;
  await raiseFlag(c, userId, 'identical_accuracy', { accuracy: acc, fixes: run, cells: cells.size }, now, DAY_MS);
}

/** True when the user's last verified fix is inside the cell and recent enough to buy with. */
export function standingIn(user: UserRow, gy: number, gx: number, now: number): boolean {
  if (!user.last_fix_at || user.last_fix_lat == null || user.last_fix_lng == null) return false;
  if (now - user.last_fix_at.getTime() > CONFIG.BUY_FIX_MAX_AGE_S * 1000) return false;
  return cellIdOf(user.last_fix_lat, user.last_fix_lng) === `${gy}:${gx}`;
}
