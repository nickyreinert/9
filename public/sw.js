const CACHE_NAME = 'nine-app-shell-v1';
const PRECACHE_URLS = ['/', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// Only full, successful, same-origin responses belong in the cache. Without
// this an offline blip or a 404/500 during a deploy gets stored and then
// served back happily on every later load; `cache.put` also throws outright
// on a 206 partial response.
function isCacheable(response) {
  return response && response.ok && response.status === 200 && response.type === 'basic';
}

function cachePut(request, response) {
  if (!isCacheable(response)) return Promise.resolve();
  const copy = response.clone();
  return caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // Only ever handle same-origin GETs. Everything else — the signaling
  // worker's API, STUN/TURN, and WebRTC itself (which doesn't go through
  // fetch anyway) — must always go straight to the network, never cached.
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Vite's build output is content-hashed and immutable, so it's safe to
  // cache aggressively. The HTML shell and manifest are network-first
  // instead, so a fresh deploy is picked up on the next successful load
  // rather than being stuck on a cached index.html forever.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            // waitUntil so the write survives the worker being shut down
            // right after the response is handed back.
            event.waitUntil(cachePut(request, response));
            return response;
          })
      )
    );
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        event.waitUntil(cachePut(request, response));
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || caches.match('/')))
  );
});
