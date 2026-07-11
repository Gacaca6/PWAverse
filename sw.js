/* ---------------------------------------------------------------------------
   PWAverse — service worker
   Strategy:
   - App shell (HTML/CSS/JS/icons): cache-first, precached on install.
   - Directory data (apps.json): network-first with cache fallback, so users
     always get the freshest app list but the directory still works offline.
   Bump CACHE_VERSION whenever precached files change.
--------------------------------------------------------------------------- */

const CACHE_VERSION = 'v11';
const SHELL_CACHE = `pwaverse-shell-${CACHE_VERSION}`;
const DATA_CACHE = `pwaverse-data-${CACHE_VERSION}`;

const SHELL_ASSETS = [
  './',
  'index.html',
  'css/styles.css',
  'js/app.js',
  'manifest.webmanifest',
  'icons/favicon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== SHELL_CACHE && key !== DATA_CACHE)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // let external launches pass through

  // Fetched app icons and screenshots: cache-first with runtime fill,
  // so tiles and app pages work offline once seen.
  if (url.pathname.includes('/icons/apps/') || url.pathname.includes('/screenshots/')) {
    event.respondWith(
      caches.open(DATA_CACHE).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const res = await fetch(request);
        if (res.ok) cache.put(request, res.clone());
        return res;
      })
    );
    return;
  }

  // Directory data (apps.json, scores.json, icons.json): network-first, cache fallback.
  if (url.pathname.includes('/data/')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(DATA_CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // App shell: cache-first.
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request))
  );
});
