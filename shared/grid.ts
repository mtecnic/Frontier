import { CONFIG } from './config.ts';

/** Cells per degree; CELL_DEG must divide one degree evenly (0.005 -> 200). */
export function cellsPerDegree(): number {
  return Math.round(1 / CONFIG.CELL_DEG);
}

export interface Cell {
  gy: number;
  gx: number;
}

export function cellOf(lat: number, lng: number): Cell {
  const cpd = cellsPerDegree();
  return { gy: Math.floor(lat * cpd), gx: Math.floor(lng * cpd) };
}

export function parcelId(gy: number, gx: number): string {
  return `${gy}:${gx}`;
}

export function cellIdOf(lat: number, lng: number): string {
  const c = cellOf(lat, lng);
  return parcelId(c.gy, c.gx);
}

const ID_RE = /^(-?\d{1,6}):(-?\d{1,6})$/;

/** Parse "gy:gx"; returns null for anything malformed, non-canonical ("07:-0") or off the globe. */
export function parseParcelId(id: string): Cell | null {
  const m = ID_RE.exec(id);
  if (!m) return null;
  const gy = Number(m[1]);
  const gx = Number(m[2]);
  if (parcelId(gy, gx) !== id) return null;
  const cpd = cellsPerDegree();
  if (gy < -90 * cpd || gy >= 90 * cpd || gx < -180 * cpd || gx >= 180 * cpd) return null;
  return { gy, gx };
}

export interface Bounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

export function cellBounds(gy: number, gx: number): Bounds {
  const cpd = cellsPerDegree();
  return { south: gy / cpd, north: (gy + 1) / cpd, west: gx / cpd, east: (gx + 1) / cpd };
}

export function cellCenter(gy: number, gx: number): { lat: number; lng: number } {
  const cpd = cellsPerDegree();
  return { lat: (gy + 0.5) / cpd, lng: (gx + 0.5) / cpd };
}

export function isInCell(lat: number, lng: number, gy: number, gx: number): boolean {
  const c = cellOf(lat, lng);
  return c.gy === gy && c.gx === gx;
}

const EARTH_KM = 6371.0088;

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial compass bearing in degrees from point 1 to point 2. */
export function bearingDeg(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = Math.PI / 180;
  const y = Math.sin((lng2 - lng1) * toRad) * Math.cos(lat2 * toRad);
  const x =
    Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) -
    Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos((lng2 - lng1) * toRad);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function compassPoint(deg: number): string {
  const points = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return points[Math.round(deg / 45) % 8]!;
}

/** Degree box that contains every point within km of (lat, lng). */
export function boxAround(lat: number, lng: number, km: number): Bounds {
  const dLat = km / 111.32;
  const cos = Math.max(0.01, Math.cos((lat * Math.PI) / 180));
  const dLng = Math.min(180, km / (111.32 * cos));
  return {
    south: Math.max(-90, lat - dLat),
    north: Math.min(90, lat + dLat),
    west: Math.max(-180, lng - dLng),
    east: Math.min(180, lng + dLng),
  };
}

/** Grid index range covering a degree box (inclusive). */
export function cellRange(b: Bounds): { gy0: number; gy1: number; gx0: number; gx1: number } {
  const lo = cellOf(b.south, b.west);
  const hi = cellOf(b.north, b.east);
  return { gy0: lo.gy, gy1: hi.gy, gx0: lo.gx, gx1: hi.gx };
}

/** Random point uniformly distributed in a disc of radius km around (lat, lng). */
export function randomPointWithin(lat: number, lng: number, km: number, rand: () => number = Math.random) {
  const r = km * Math.sqrt(rand());
  const theta = rand() * 2 * Math.PI;
  const dLat = (r * Math.cos(theta)) / 111.32;
  const dLng = (r * Math.sin(theta)) / (111.32 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
  let outLng = lng + dLng;
  if (outLng >= 180) outLng -= 360;
  if (outLng < -180) outLng += 360;
  return { lat: Math.max(-89.999, Math.min(89.999, lat + dLat)), lng: outLng };
}
