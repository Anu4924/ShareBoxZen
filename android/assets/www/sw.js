// ShareBoxZen Lightweight Offline Service Worker
const CACHE_NAME = 'shareboxzen-v1.0.4';
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/vendor/supabase.js',
  '/js/chunker.js',
  '/js/nearby.js',
  '/js/app.js',
  '/icon-192.png',
  '/icon-512.png',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_URLS).catch((err) => {
        console.warn('Pre-caching assets notice:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Bypass cache for API transfers, WebSockets, downloads, and uploads
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/d/') || url.pathname.startsWith('/share/')) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      return cached || fetch(event.request).catch(() => caches.match('/'));
    })
  );
});
