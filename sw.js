const CACHE_NAME = 'qingzhang-pwa-v8';
const ASSETS = [
  './',
  './index.html',
  './styles.css?v=8',
  './manifest.webmanifest',
  './preload.js?v=8',
  './js/store.js?v=8',
  './js/crypto_sync.js?v=8',
  './js/ios_widget.js?v=8',
  './js/xlsx_lite.js?v=8',
  './js/reconcile.js?v=8',
  './js/app.js?v=8',
  './icons/icon.svg',
  './icons/apple-touch-icon.png',
  './icons/pwa-192x192.png',
  './icons/pwa-512x512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Never intercept cross-origin sync calls (GitHub Gist / Apps Script), API routes, or pair_vault.json
  if (
    url.origin !== self.location.origin ||
    url.pathname.includes('/api/') ||
    url.pathname.endsWith('/pair_vault.json')
  ) {
    return;
  }

  // Navigation requests: network first with cache fallback to ./index.html (offline launch)
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put('./index.html', copy));
          }
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Core app code/styles: Network-First so HTML/JS/CSS always upgrade atomically together
  if (/\.(?:html|js|css|webmanifest)$/i.test(url.pathname)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Icons and binary static assets: Stale-While-Revalidate
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
