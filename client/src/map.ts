import * as ml from 'maplibre-gl';
import { CONFIG } from '../../shared/config.ts';
import { cellBounds, cellCenter, cellIdOf, cellOf, cellsPerDegree, parseParcelId } from '../../shared/grid.ts';
import { parcelColor, type ParcelColor } from '../../shared/pricing.ts';
import type { ParcelView, PrizeView, PromotionView } from '../../shared/types.ts';
import { api } from './api.ts';
import { ART } from './art.ts';
import { emit, noteServerTime, on, state } from './state.ts';
import { debounce, store } from './util.ts';

export const COLORS: Record<ParcelColor, string> = {
  unowned: '#2f7fd8',
  mine: '#2e9e4f',
  yellow: '#f2c230',
  orange: '#f0802a',
  red: '#d9342b',
};

const DEFAULT_STYLE = 'https://tiles.openfreemap.org/styles/positron';

let map: ml.Map;
let avatar: ml.Marker | null = null;
let selected: string | null = null;
let onTap: (id: string) => void = () => {};
let hasGlyphs = true;
let layersReady = false;

export function getMap(): ml.Map {
  return map;
}

function fallbackStyle(): any {
  return {
    version: 8,
    sources: {},
    layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#eef0e8' } }],
  };
}

async function resolveStyle(url: string): Promise<any> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) throw new Error(String(res.status));
    const style = await res.json();
    hasGlyphs = !!style.glyphs;
    return style;
  } catch (err) {
    console.warn('Map style unavailable, using a plain background:', err);
    hasGlyphs = false;
    return fallbackStyle();
  }
}

function loadImage(name: string, svg: string, size = 64): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image(size, size);
    img.onload = () => {
      if (!map.hasImage(name)) map.addImage(name, img, { pixelRatio: 2 });
      resolve();
    };
    img.onerror = () => resolve();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}

const empty = (): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features: [] });

function setData(source: string, data: GeoJSON.FeatureCollection) {
  const s = map.getSource(source) as ml.GeoJSONSource | undefined;
  s?.setData(data);
}

function cellPolygon(gy: number, gx: number): GeoJSON.Polygon {
  const b = cellBounds(gy, gx);
  return {
    type: 'Polygon',
    coordinates: [[[b.west, b.south], [b.east, b.south], [b.east, b.north], [b.west, b.north], [b.west, b.south]]],
  };
}

function circlePolygon(lat: number, lng: number, meters: number): GeoJSON.Polygon {
  const pts: [number, number][] = [];
  const dLat = meters / 111_320;
  const dLng = meters / (111_320 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    pts.push([lng + dLng * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return { type: 'Polygon', coordinates: [pts] };
}

function addLayers() {
  const firstSymbol = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
  const src = (id: string) => map.addSource(id, { type: 'geojson', data: empty() });
  ['tint', 'grid', 'owned', 'here', 'selected', 'labels', 'icons', 'dots', 'accuracy'].forEach(src);

  map.addLayer(
    { id: 'tint', type: 'fill', source: 'tint', minzoom: CONFIG.GRID_MIN_ZOOM, paint: { 'fill-color': COLORS.unowned, 'fill-opacity': 0.07 } },
    firstSymbol,
  );
  map.addLayer(
    {
      id: 'owned-fill',
      type: 'fill',
      source: 'owned',
      minzoom: CONFIG.GRID_MIN_ZOOM,
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['case', ['get', 'mine'], 0.42, 0.38] },
    },
    firstSymbol,
  );
  map.addLayer(
    {
      id: 'grid',
      type: 'line',
      source: 'grid',
      minzoom: CONFIG.GRID_MIN_ZOOM,
      paint: { 'line-color': COLORS.unowned, 'line-opacity': ['interpolate', ['linear'], ['zoom'], 12, 0.25, 15, 0.45], 'line-width': 0.8 },
    },
    firstSymbol,
  );
  map.addLayer(
    {
      id: 'owned-line',
      type: 'line',
      source: 'owned',
      minzoom: CONFIG.GRID_MIN_ZOOM,
      paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1, 16, 2.2], 'line-opacity': 0.9 },
    },
    firstSymbol,
  );
  map.addLayer({
    id: 'accuracy',
    type: 'fill',
    source: 'accuracy',
    paint: { 'fill-color': '#1f2b3a', 'fill-opacity': 0.08 },
  });
  map.addLayer({
    id: 'here',
    type: 'line',
    source: 'here',
    paint: { 'line-color': '#1f2b3a', 'line-width': 3, 'line-opacity': 0.85 },
  });
  map.addLayer({
    id: 'selected',
    type: 'line',
    source: 'selected',
    paint: { 'line-color': '#b4532a', 'line-width': 3, 'line-dasharray': [2, 1.2] },
  });
  map.addLayer({
    id: 'dots',
    type: 'circle',
    source: 'dots',
    maxzoom: CONFIG.GRID_MIN_ZOOM,
    paint: {
      'circle-color': ['get', 'color'],
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 2.5, 11, 5],
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 1,
    },
  });
  if (hasGlyphs) {
    map.addLayer({
      id: 'labels',
      type: 'symbol',
      source: 'labels',
      minzoom: CONFIG.LABEL_MIN_ZOOM,
      layout: {
        'text-field': ['get', 't'],
        'text-font': ['Noto Sans Bold'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 14, 10, 17, 13],
        'text-anchor': 'top-left',
        'text-offset': [0.35, 0.25],
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: { 'text-color': ['get', 'c'], 'text-halo-color': 'rgba(255,255,255,0.9)', 'text-halo-width': 1.4 },
    });
  }
  map.addLayer({
    id: 'icons',
    type: 'symbol',
    source: 'icons',
    minzoom: CONFIG.GRID_MIN_ZOOM,
    layout: {
      'icon-image': ['get', 'icon'],
      'icon-size': ['interpolate', ['linear'], ['zoom'], 12, 0.42, 16, 0.75],
      'icon-offset': ['get', 'off'],
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });
  layersReady = true;
}

/** Recompute every overlay source from state for the current view. */
export function render() {
  if (!layersReady) return;
  const z = map.getZoom();
  const myId = state.me?.id ?? null;
  const b = map.getBounds();
  const cpd = cellsPerDegree();
  const gy0 = Math.floor(b.getSouth() * cpd) - 1;
  const gy1 = Math.floor(b.getNorth() * cpd) + 1;
  const gx0 = Math.floor(b.getWest() * cpd) - 1;
  const gx1 = Math.floor(b.getEast() * cpd) + 1;
  const rows = gy1 - gy0 + 1;
  const cols = gx1 - gx0 + 1;

  const owned: GeoJSON.Feature[] = [];
  const dots: GeoJSON.Feature[] = [];
  const icons: GeoJSON.Feature[] = [];
  const labels: GeoJSON.Feature[] = [];

  for (const p of state.parcels.values()) {
    const color = COLORS[parcelColor(p.ownerId, myId, p.price)];
    const mine = p.ownerId != null && p.ownerId === myId;
    if (z < CONFIG.GRID_MIN_ZOOM) {
      const c = cellCenter(p.gy, p.gx);
      dots.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [c.lng, c.lat] }, properties: { id: p.id, color } });
      continue;
    }
    if (p.gy < gy0 || p.gy > gy1 || p.gx < gx0 || p.gx > gx1) continue;
    owned.push({ type: 'Feature', geometry: cellPolygon(p.gy, p.gx), properties: { id: p.id, color, mine } });
    const c = cellCenter(p.gy, p.gx);
    const both = p.spook && p.store;
    if (p.spook)
      icons.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [c.lng, c.lat] }, properties: { icon: 'ghost', off: both ? [-30, 0] : [0, 0] } });
    if (p.store)
      icons.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [c.lng, c.lat] }, properties: { icon: 'cabin', off: both ? [30, 0] : [0, 0] } });
  }

  const pinAt = (gy: number, gx: number, icon: string, off: [number, number]) => {
    const c = cellCenter(gy, gx);
    icons.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [c.lng, c.lat] }, properties: { icon, off } });
  };
  state.prizes.forEach((p: PrizeView) => pinAt(p.gy, p.gx, 'nugget', [0, 28]));
  state.promotions.forEach((p: PromotionView) => pinAt(p.gy, p.gx, 'promo', [0, -28]));

  let grid: GeoJSON.FeatureCollection = empty();
  let tint: GeoJSON.FeatureCollection = empty();
  if (z >= CONFIG.GRID_MIN_ZOOM && rows * cols < 200_000) {
    const lines: [number, number][][] = [];
    const w = gx0 / cpd;
    const e = (gx1 + 1) / cpd;
    const s = gy0 / cpd;
    const n = (gy1 + 1) / cpd;
    for (let gy = gy0; gy <= gy1 + 1; gy++) lines.push([[w, gy / cpd], [e, gy / cpd]]);
    for (let gx = gx0; gx <= gx1 + 1; gx++) lines.push([[gx / cpd, s], [gx / cpd, n]]);
    grid = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'MultiLineString', coordinates: lines }, properties: {} }] };
    tint = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] }, properties: {} }],
    };
    if (z >= CONFIG.LABEL_MIN_ZOOM && rows * cols <= 4000) {
      for (let gy = gy0; gy <= gy1; gy++) {
        for (let gx = gx0; gx <= gx1; gx++) {
          const p = state.parcels.get(`${gy}:${gx}`);
          const price = p ? p.price : CONFIG.UNOWNED_PRICE;
          const col = p ? parcelColor(p.ownerId, myId, p.price) : 'unowned';
          labels.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [gx / cpd, (gy + 1) / cpd] },
            properties: { t: price.toLocaleString('en-US'), c: col === 'yellow' ? '#8a6a00' : COLORS[col] },
          });
        }
      }
    }
  }

  setData('tint', tint);
  setData('grid', grid);
  setData('owned', { type: 'FeatureCollection', features: owned });
  setData('dots', { type: 'FeatureCollection', features: dots });
  setData('icons', { type: 'FeatureCollection', features: icons });
  if (hasGlyphs) setData('labels', { type: 'FeatureCollection', features: labels });
  renderSelected();
  renderFix();
}

function renderSelected() {
  const c = selected ? parseParcelId(selected) : null;
  setData(
    'selected',
    c ? { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: cellPolygon(c.gy, c.gx), properties: {} }] } : empty(),
  );
}

function renderFix() {
  if (!layersReady) return;
  const f = state.fix;
  if (!f) {
    setData('here', empty());
    setData('accuracy', empty());
    avatar?.remove();
    avatar = null;
    return;
  }
  const c = cellOf(f.lat, f.lng);
  setData('here', { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: cellPolygon(c.gy, c.gx), properties: {} }] });
  setData('accuracy', {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: circlePolygon(f.lat, f.lng, Math.min(f.accuracy, 2000)), properties: {} }],
  });
  if (!avatar) {
    const el = document.createElement('div');
    el.className = 'avatar';
    el.innerHTML = ART.avatar;
    avatar = new ml.Marker({ element: el }).setLngLat([f.lng, f.lat]).addTo(map);
  } else avatar.setLngLat([f.lng, f.lat]);
}

/** Keep the player (and the selected parcel) visible beside an open sheet. */
function syncPadding() {
  if (!map) return;
  const sheet = document.getElementById('sheet');
  const open = !!sheet?.classList.contains('open');
  const wide = window.innerWidth >= 820;
  const h = open ? sheet!.getBoundingClientRect().height : 0;
  const pad = open
    ? wide
      ? { top: 0, bottom: 0, left: 0, right: Math.min(sheet!.getBoundingClientRect().width + 12, window.innerWidth / 2) }
      : { top: 60, bottom: Math.min(h, window.innerHeight * 0.6), left: 0, right: 0 }
    : { top: 0, bottom: 0, left: 0, right: 0 };
  map.easeTo({ padding: pad, duration: 250 });
}

/** Pan so a cell is visible if the open sheet hides it. */
export function revealCell(id: string) {
  const c = parseParcelId(id);
  if (!c || !map) return;
  const ctr = cellCenter(c.gy, c.gx);
  const pt = map.project([ctr.lng, ctr.lat]);
  const sheet = document.getElementById('sheet')!.getBoundingClientRect();
  const hidden = window.innerWidth >= 820 ? pt.x > sheet.left - 20 : pt.y > sheet.top - 20 || pt.y < 70;
  if (hidden) {
    if (state.follow && state.fix && cellIdOf(state.fix.lat, state.fix.lng) !== id) setFollow(false);
    map.easeTo({ center: [ctr.lng, ctr.lat], duration: 400 });
  }
}

export function setSelected(id: string | null) {
  selected = id;
  if (layersReady) renderSelected();
}

export function flyToCell(id: string, zoom = Math.max(map.getZoom(), 15)) {
  const c = parseParcelId(id);
  if (!c) return;
  const ctr = cellCenter(c.gy, c.gx);
  setFollow(false);
  map.flyTo({ center: [ctr.lng, ctr.lat], zoom, speed: 1.6 });
}

export function centerOnFix() {
  if (!state.fix) return;
  map.easeTo({ center: [state.fix.lng, state.fix.lat], zoom: Math.max(map.getZoom(), 15), duration: 600 });
}

export function setFollow(on: boolean) {
  if (state.follow === on) return;
  state.follow = on;
  store('follow', on);
  emit('follow');
  if (on) centerOnFix();
}

// ---- Data -------------------------------------------------------------------

let fetchSeq = 0;
let lastFetch: { w: number; s: number; e: number; n: number; at: number; truncated: boolean } | null = null;

/** Fetch owned parcels for the view (padded). Small pans inside the last fetch reuse it for 30 s. */
export async function refreshParcels(force = true) {
  if (!map) return;
  const b = map.getBounds();
  if (
    !force &&
    lastFetch &&
    !lastFetch.truncated &&
    Date.now() - lastFetch.at < 30_000 &&
    b.getWest() >= lastFetch.w &&
    b.getEast() <= lastFetch.e &&
    b.getSouth() >= lastFetch.s &&
    b.getNorth() <= lastFetch.n
  )
    return;
  const seq = ++fetchSeq;
  const padLat = (b.getNorth() - b.getSouth()) * 0.25;
  const padLng = (b.getEast() - b.getWest()) * 0.25;
  const w = Math.max(-180, b.getWest() - padLng);
  const e = Math.min(180, b.getEast() + padLng);
  const s = Math.max(-85, b.getSouth() - padLat);
  const n = Math.min(85, b.getNorth() + padLat);
  try {
    const r = await api<{ parcels: ParcelView[]; truncated: boolean; prizes: PrizeView[]; promotions: PromotionView[]; serverTime: string }>(
      'GET',
      `/parcels?bbox=${w.toFixed(5)},${s.toFixed(5)},${e.toFixed(5)},${n.toFixed(5)}`,
    );
    if (seq !== fetchSeq) return;
    lastFetch = { w, s, e, n, at: Date.now(), truncated: r.truncated };
    noteServerTime(r.serverTime);
    const cpd = cellsPerDegree();
    if (!r.truncated) {
      const gy0 = Math.floor(s * cpd);
      const gy1 = Math.floor(n * cpd);
      const gx0 = Math.floor(w * cpd);
      const gx1 = Math.floor(e * cpd);
      for (const [id, p] of state.parcels) {
        if (p.gy >= gy0 && p.gy <= gy1 && p.gx >= gx0 && p.gx <= gx1) state.parcels.delete(id);
      }
    }
    for (const p of r.parcels) state.parcels.set(p.id, p);
    state.prizes = r.prizes;
    state.promotions = r.promotions;
    emit('parcels');
  } catch (err) {
    console.warn('parcel refresh failed', err);
  }
}

/** Merge one parcel's fresh state (after a purchase etc.). */
export function upsertParcel(p: ParcelView) {
  if (p.ownerId == null) state.parcels.delete(p.id);
  else state.parcels.set(p.id, p);
  emit('parcels');
}

// ---- Setup ------------------------------------------------------------------

export async function initMap(container: HTMLElement, tap: (id: string) => void) {
  onTap = tap;
  const cfg = window.FRONTIER_CONFIG ?? {};
  const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  const styleUrl = (dark && cfg.mapStyleDark) || cfg.mapStyle || DEFAULT_STYLE;
  const style = await resolveStyle(styleUrl);
  const last = (() => {
    try {
      return JSON.parse(localStorage.getItem('frontier:view') || 'null');
    } catch {
      return null;
    }
  })();
  map = new ml.Map({
    container,
    style,
    center: last?.center ?? cfg.defaultCenter ?? [-98.5, 39.5],
    zoom: last?.zoom ?? cfg.defaultZoom ?? (cfg.defaultCenter ? 13 : 3.5),
    attributionControl: { compact: true },
    maxPitch: 0,
    dragRotate: false,
    pitchWithRotate: false,
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new ml.ScaleControl({ maxWidth: 90, unit: navigator.language === 'en-US' ? 'imperial' : 'metric' }), 'bottom-left');

  await new Promise<void>((resolve) => map.once('load', () => resolve()));
  await Promise.all([loadImage('ghost', ART.ghost), loadImage('cabin', ART.cabin), loadImage('nugget', ART.nugget), loadImage('promo', ART.promo)]);
  addLayers();

  const refetch = debounce(() => refreshParcels(false), 250);
  map.on('moveend', () => {
    render();
    refetch();
    const c = map.getCenter();
    store('view', { center: [c.lng, c.lat], zoom: map.getZoom() });
  });
  map.on('dragstart', () => setFollow(false));
  map.on('click', (e) => {
    const z = map.getZoom();
    if (z < CONFIG.GRID_MIN_ZOOM) {
      const hit = map.queryRenderedFeatures(e.point, { layers: ['dots'] })[0];
      if (hit?.properties?.id) {
        flyToCell(String(hit.properties.id), 15);
        onTap(String(hit.properties.id));
      } else {
        setFollow(false);
        map.easeTo({ center: e.lngLat, zoom: Math.min(CONFIG.GRID_MIN_ZOOM + 2, z + 4) });
      }
      return;
    }
    onTap(cellIdOf(e.lngLat.lat, e.lngLat.lng));
  });

  document.addEventListener('frontier:sheet', () => setTimeout(syncPadding, 300));
  window.addEventListener('resize', () => setTimeout(syncPadding, 100));
  on('parcels', render);
  on('me', render);
  on('fix', () => {
    renderFix();
    if (state.follow && state.fix) map.easeTo({ center: [state.fix.lng, state.fix.lat], duration: 500 });
  });

  setInterval(() => {
    if (document.visibilityState === 'visible') refreshParcels();
  }, 45_000);
  render();
  refreshParcels();
}
