// Service worker — caches app shell so returning from background doesn't trigger a full reload.
// Uses a network-first strategy for navigation and cache-first for static assets.

const CACHE_NAME = 'corkboards-v2';

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

  // Entry JS/CSS (index.js, index.css) — network-first since filenames don't change between deploys
  if (/\/assets\/index\.(js|css)/.test(url.pathname)) {
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

  // Static assets (vendor chunks, images, fonts): cache-first, fall back to network
  if (/\.(js|css|woff2?|ttf|png|jpg|jpeg|gif|svg|ico|webp)(\?.*)?$/.test(url.pathname) ||
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
