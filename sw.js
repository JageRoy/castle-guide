// Offline cache for the castle guide. Active only over HTTPS or localhost
// (browsers refuse service workers on plain http LAN addresses).
// Bump VERSION whenever any file below changes.
const VERSION = 'castle-v1';
const FILES = [
  './', 'index.html', 'style.css', 'manifest.json', 'src/main.js',
  'vendor/three.module.js', 'vendor/three.core.js', 'vendor/OrbitControls.js',
  'data/castle.bin', 'data/parts.json', 'data/steps.json',
  'fonts/heebo-hebrew-400-normal.woff2', 'fonts/heebo-hebrew-700-normal.woff2',
  'fonts/heebo-hebrew-800-normal.woff2', 'fonts/heebo-latin-400-normal.woff2',
  'fonts/heebo-latin-700-normal.woff2', 'fonts/heebo-latin-800-normal.woff2',
  'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png',
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  url.search = '';                       // ?step=3 still hits the cached page
  e.respondWith(caches.match(url.href).then(hit => hit || fetch(e.request)));
});
