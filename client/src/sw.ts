/// <reference lib="webworker" />
// Service worker: caches the app shell and recently viewed map tiles, shows jump alerts.
// The game itself never works offline: API calls always go to the network.

declare const self: ServiceWorkerGlobalScope;
declare const __BUILD__: string;

const SHELL = `frontier-shell-${__BUILD__}`;
const TILES = 'frontier-tiles-v1';
const MAX_TILES = 3000;

const SHELL_FILES = [
  './',
  './index.html',
  `./app.js?v=${__BUILD__}`,
  `./app.css?v=${__BUILD__}`,
  './config.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './vendor/maplibre/maplibre-gl.js',
  './vendor/maplibre/maplibre-gl-shared.js',
  './vendor/maplibre/maplibre-gl-worker.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(SHELL_FILES.map((f) => new Request(f, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key.startsWith('frontier-shell-') && key !== SHELL) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

function isTile(url: URL): boolean {
  if (url.origin === self.location.origin) return false;
  return /\.(pbf|mvt|png|jpe?g|webp|json)$/i.test(url.pathname) || /\/(styles|fonts|sprites?|tiles?|planet)\//.test(url.pathname);
}

async function trimTiles() {
  const cache = await caches.open(TILES);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await cache.delete(keys[i]!);
}

let trimScheduled = false;

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const scope = new URL(self.registration.scope);

  // API: always network.
  if (url.origin === scope.origin && url.pathname.startsWith(scope.pathname + 'api/')) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(async () => (await caches.match('./index.html', { cacheName: SHELL })) ?? Response.error()),
    );
    return;
  }

  if (url.origin === self.location.origin && url.pathname.endsWith('/config.js')) {
    // Deploy-time settings: always try the network so edits apply immediately.
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) caches.open(SHELL).then((c) => c.put('./config.js', res.clone()));
          return res;
        })
        .catch(async () => (await caches.match('./config.js', { cacheName: SHELL })) ?? Response.error()),
    );
    return;
  }

  if (url.origin === self.location.origin) {
    // Shell: serve from cache, refresh in the background.
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL);
        const hit = await cache.match(req);
        const net = fetch(req)
          .then((res) => {
            if (res.ok && SHELL_FILES.some((f) => new URL(f, scope).href === url.href)) cache.put(req, res.clone());
            return res;
          })
          .catch(() => hit ?? Response.error());
        return hit ?? net;
      })(),
    );
    return;
  }

  if (isTile(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(TILES);
        const hit = await cache.match(req);
        const net = fetch(req)
          .then((res) => {
            if (res.ok) {
              cache.put(req, res.clone());
              if (!trimScheduled) {
                trimScheduled = true;
                setTimeout(() => {
                  trimScheduled = false;
                  trimTiles();
                }, 10_000);
              }
            }
            return res;
          })
          .catch(() => hit ?? Response.error());
        return hit ?? net;
      })(),
    );
  }
});

self.addEventListener('push', (event) => {
  let data: { title?: string; body?: string; url?: string; tag?: string } = {};
  try {
    data = event.data?.json() ?? {};
  } catch {
    data = { body: event.data?.text() };
  }
  event.waitUntil(
    self.registration.showNotification(data.title ?? 'Frontier', {
      body: data.body ?? '',
      tag: data.tag,
      icon: './icons/icon-192.png',
      badge: './icons/badge-96.png',
      data: { url: data.url ?? '#/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const hash = String(event.notification.data?.url ?? '#/');
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of all) {
        if ('focus' in c) {
          await (c as WindowClient).focus();
          c.postMessage({ type: 'navigate', url: hash });
          return;
        }
      }
      await self.clients.openWindow(new URL(hash, self.registration.scope).toString());
    })(),
  );
});

export {};
