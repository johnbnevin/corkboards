// Service worker — caches app shell so returning from background doesn't trigger a full reload.
// Uses a network-first strategy for navigation and cache-first for static assets.

// CACHE_VERSION is rewritten to a unique build timestamp by the production
// build step (see packages/web/package.json "build"), so EVERY deploy ships a
// new CACHE_NAME. That changes this file's bytes → the browser installs the new
// SW → the activate handler purges ALL previous caches. This prevents stale
// chunks from surviving a deploy, including the bug where a cached plain
// `index.js` ran alongside the fresh `index.js?v=…` and mounted the app twice.
// In dev (no build step) the literal token is a valid, stable cache name.
const CACHE_NAME = 'corkboards-CACHE_VERSION';

// On install, immediately activate (don't wait for existing tabs to close)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  // Skip non-GET requests
  if (request.method !== 'GET') return;

  // Skip rss-proxy.php and API-like requests
  if (url.pathname.includes('rss-proxy') || url.pathname.startsWith('/api')) return;

  // Navigation requests (HTML): network-first, fall back to cache
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return response;
        })
        .catch(() => caches.match(request).then((r) => r || caches.match('/')))
    );
    return;
  }

  // ALL app JS/CSS (entry + vendor chunks) — NETWORK-FIRST.
  // Chunk filenames are stable (no content hash), so a cache-first vendor chunk
  // can go stale and mismatch a freshly-deployed entry — the app then boots with
  // an incompatible bundle set and renders a blank screen that survives refresh
  // (the SW keeps serving the same stale chunk) until site data is cleared.
  // Fetching JS/CSS network-first keeps the whole bundle set consistent; the
  // cache is only an offline fallback.
  if (/\.(js|css)(\?.*)?$/.test(url.pathname)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Other static assets (images, fonts): cache-first, fall back to network
  if (/\.(woff2?|ttf|png|jpg|jpeg|gif|svg|ico|webp)(\?.*)?$/.test(url.pathname) ||
      url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return response;
        });
      })
    );
    return;
  }
});
