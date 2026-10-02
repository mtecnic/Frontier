import { randomBytes } from 'node:crypto';
import { CONFIG, HOUR_MS } from '../shared/config.ts';
import { cellIdOf, parseParcelId, type Cell } from '../shared/grid.ts';
import { pool, q, q1, tx } from './db.ts';
import { lockUser } from './economy.ts';
import { bad, conflict, forbidden, notFound } from './http.ts';
import { standingIn } from './location.ts';
import { buildMe } from './me.ts';

/** Accept either parcelId "gy:gx" or lat/lng in an admin form. */
export function cellFromInput(body: any): { id: string; cell: Cell } {
  if (typeof body?.parcelId === 'string' && body.parcelId.trim()) {
    const id = body.parcelId.trim();
    const cell = parseParcelId(id);
    if (!cell) throw bad('invalid_parcel', 'Parcel ID must look like 7233:-23028.');
    return { id, cell };
  }
  const lat = Number(body?.lat);
  const lng = Number(body?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)
    throw bad('invalid_location', 'Give a parcel ID or a latitude and longitude.');
  const id = cellIdOf(lat, lng);
  return { id, cell: parseParcelId(id)! };
}

function optDate(v: unknown, name: string): Date | null {
  if (v == null || v === '') return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw bad('invalid_' + name, `${name} is not a valid date`);
  return d;
}

function optUrl(v: unknown): string | null {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (!/^https?:\/\/\S+$/i.test(s) || s.length > 500) throw bad('invalid_url', 'Links must start with http:// or https://');
  return s;
}

function reqText(v: unknown, name: string, max: number, min = 1): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length < min || s.length > max) throw bad('invalid_' + name, `${name} must be ${min}-${max} characters`);
  return s;
}

// ---- Promotions (admin-entered offers pinned to a parcel) ----

export async function listPromotions() {
  return q(pool, 'SELECT * FROM promotions ORDER BY active DESC, created_at DESC LIMIT 500');
}

export async function createPromotion(body: any, at: number) {
  const { id, cell } = cellFromInput(body);
  return q1(
    pool,
    `INSERT INTO promotions (parcel_id, gy, gx, business, title, body, url, starts_at, ends_at, active, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10) RETURNING *`,
    [
      id,
      cell.gy,
      cell.gx,
      reqText(body?.business, 'business', 80),
      reqText(body?.title, 'title', 120),
      typeof body?.body === 'string' ? body.body.trim().slice(0, 1000) : '',
      optUrl(body?.url),
      optDate(body?.startsAt, 'startsAt'),
      optDate(body?.endsAt, 'endsAt'),
      new Date(at),
    ],
  );
}

export async function updatePromotion(promoId: number, body: any) {
  const cur = await q1(pool, 'SELECT * FROM promotions WHERE id = $1', [promoId]);
  if (!cur) throw notFound('No such promotion');
  const loc = body?.parcelId || body?.lat != null ? cellFromInput(body) : null;
  return q1(
    pool,
    `UPDATE promotions SET parcel_id = $2, gy = $3, gx = $4, business = $5, title = $6, body = $7, url = $8,
            starts_at = $9, ends_at = $10, active = $11 WHERE id = $1 RETURNING *`,
    [
      promoId,
      loc?.id ?? cur.parcel_id,
      loc?.cell.gy ?? cur.gy,
      loc?.cell.gx ?? cur.gx,
      body?.business !== undefined ? reqText(body.business, 'business', 80) : cur.business,
      body?.title !== undefined ? reqText(body.title, 'title', 120) : cur.title,
      body?.body !== undefined ? String(body.body).trim().slice(0, 1000) : cur.body,
      body?.url !== undefined ? optUrl(body.url) : cur.url,
      body?.startsAt !== undefined ? optDate(body.startsAt, 'startsAt') : cur.starts_at,
      body?.endsAt !== undefined ? optDate(body.endsAt, 'endsAt') : cur.ends_at,
      body?.active !== undefined ? !!body.active : cur.active,
    ],
  );
}

// ---- QR stations (scan with a verified fix in the parcel for a free Flare) ----

export async function listStations() {
  return q(
    pool,
    `SELECT s.*, (SELECT count(*) FROM qr_redemptions r WHERE r.station_id = s.id) AS redemptions
       FROM qr_stations s ORDER BY s.active DESC, s.created_at DESC LIMIT 500`,
  );
}

export async function createStation(body: any, at: number) {
  const { id, cell } = cellFromInput(body);
  const token = randomBytes(12).toString('base64url');
  return q1(
    pool,
    'INSERT INTO qr_stations (token, parcel_id, gy, gx, name, active, created_at) VALUES ($1, $2, $3, $4, $5, true, $6) RETURNING *',
    [token, id, cell.gy, cell.gx, reqText(body?.name, 'name', 80), new Date(at)],
  );
}

export async function updateStation(stationId: number, body: any) {
  const r = await q1(
    pool,
    'UPDATE qr_stations SET active = coalesce($2, active), name = coalesce($3, name) WHERE id = $1 RETURNING *',
    [stationId, body?.active === undefined ? null : !!body.active, body?.name ? reqText(body.name, 'name', 80) : null],
  );
  if (!r) throw notFound('No such station');
  return r;
}

/** Redeem a scanned code: needs a verified fix in the station's parcel; once per player per station per day. */
export async function redeemQr(userId: number, token: string, at: number) {
  return tx(async (c) => {
    const station = (await c.query('SELECT * FROM qr_stations WHERE token = $1', [token])).rows[0];
    if (!station || !station.active) throw notFound("That code isn't an active refill station.");
    const user = await lockUser(c, userId);
    if (!standingIn(user, station.gy, station.gx, at))
      throw forbidden('not_here', `Scan this code while standing at ${station.name} (parcel ${station.parcel_id}).`);
    const last = (
      await c.query<{ time: Date }>(
        'SELECT time FROM qr_redemptions WHERE station_id = $1 AND user_id = $2 ORDER BY time DESC LIMIT 1',
        [station.id, userId],
      )
    ).rows[0];
    const cooldown = CONFIG.QR_COOLDOWN_HOURS * HOUR_MS;
    if (last && at - last.time.getTime() < cooldown)
      throw conflict('cooldown', 'You already collected a Flare here today.', {
        nextAt: new Date(last.time.getTime() + cooldown).toISOString(),
      });
    if (user.flares >= CONFIG.MAX_FLARES)
      throw conflict('carry_limit', `You're already carrying ${CONFIG.MAX_FLARES} Flares.`);
    await c.query('UPDATE users SET flares = flares + 1 WHERE id = $1', [userId]);
    await c.query('INSERT INTO qr_redemptions (station_id, user_id, time) VALUES ($1, $2, $3)', [
      station.id,
      userId,
      new Date(at),
    ]);
    return { station: station.name, me: await buildMe(c, userId, at) };
  });
}

