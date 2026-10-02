import { CONFIG } from '../shared/config.ts';
import { boxAround, cellCenter, cellRange, haversineKm } from '../shared/grid.ts';
import type { PrizeView, PromotionView } from '../shared/types.ts';
import { q, type Db } from './db.ts';

/** Live prizes within PRIZE_VISIBLE_KM of a point, nearest first. */
export async function prizesNear(db: Db, lat: number, lng: number, at: number): Promise<PrizeView[]> {
  const r = cellRange(boxAround(lat, lng, CONFIG.PRIZE_VISIBLE_KM + 0.5));
  const rows = await q<{ id: number; parcel_id: string; gy: number; gx: number; expires_at: Date }>(
    db,
    `SELECT id, parcel_id, gy, gx, expires_at FROM prizes
      WHERE gx BETWEEN $1 AND $2 AND gy BETWEEN $3 AND $4 AND claimed_by IS NULL AND expires_at > $5`,
    [r.gx0, r.gx1, r.gy0, r.gy1, new Date(at)],
  );
  return rows
    .map((p) => {
      const c = cellCenter(p.gy, p.gx);
      return {
        id: p.id,
        parcelId: p.parcel_id,
        gy: p.gy,
        gx: p.gx,
        expiresAt: p.expires_at.toISOString(),
        distanceKm: haversineKm(lat, lng, c.lat, c.lng),
      };
    })
    .filter((p) => p.distanceKm <= CONFIG.PRIZE_VISIBLE_KM)
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

/** Active promotions within PROMO_VISIBLE_KM of a point, nearest first. */
export async function promotionsNear(db: Db, lat: number, lng: number, at: number): Promise<PromotionView[]> {
  const r = cellRange(boxAround(lat, lng, CONFIG.PROMO_VISIBLE_KM + 0.5));
  const rows = await q<{
    id: number;
    parcel_id: string;
    gy: number;
    gx: number;
    business: string;
    title: string;
    body: string;
    url: string | null;
    ends_at: Date | null;
  }>(
    db,
    `SELECT * FROM promotions
      WHERE gx BETWEEN $1 AND $2 AND gy BETWEEN $3 AND $4 AND active
        AND (starts_at IS NULL OR starts_at <= $5) AND (ends_at IS NULL OR ends_at > $5)`,
    [r.gx0, r.gx1, r.gy0, r.gy1, new Date(at)],
  );
  return rows
    .map((p) => {
      const c = cellCenter(p.gy, p.gx);
      return {
        id: p.id,
        parcelId: p.parcel_id,
        gy: p.gy,
        gx: p.gx,
        business: p.business,
        title: p.title,
        body: p.body,
        url: p.url,
        endsAt: p.ends_at?.toISOString() ?? null,
        distanceKm: haversineKm(lat, lng, c.lat, c.lng),
      };
    })
    .filter((p) => p.distanceKm <= CONFIG.PROMO_VISIBLE_KM)
    .sort((a, b) => a.distanceKm - b.distanceKm);
}
