// sw.js — a minimal "app shell" cache. Not fancy: on install, it grabs the
// core files so the app still opens (with whatever data is already in
// localStorage) even with no internet connection — which matters once
// it's installed as a home-screen app and might get opened mid-hike.

const CACHE_NAME = 'judgement-center-v1';
const SHELL_FILES = [
  'index.html',
  'css/style.css',
  'js/storage.js',
  'js/parser.js',
  'js/plan.js',
  'js/charts.js',
  'js/app.js',
  'manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // clean up any old cache versions left over from a previous deploy
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

// "cache first, fall back to network" — fine for an app shell that doesn't
// change often. Chart.js from the CDN falls through to the network as
// normal when online, and simply fails quietly if offline (charts just
// won't render until you're back online — everything else still works).
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
