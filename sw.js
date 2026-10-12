// Lets the tea picker open without a connection. Every request tries the network first, so a newly
// published page shows up straight away; the saved copy is only used when the network fails.
// Cache storage is shared by every site under bgornik.github.io, so the name is namespaced.
const CACHE = 'webapp.offline';
const FILES = ['./', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || !request.url.startsWith(self.registration.scope)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(request);
      if (response.ok) event.waitUntil(cache.put(request, response.clone()).catch(() => {}));
      return response;
    } catch (error) {
      // Any address of the page itself (such as index.html) falls back to the saved page.
      const saved = await cache.match(request) || (request.mode === 'navigate' && await cache.match('./'));
      if (saved) return saved;
      throw error;
    }
  })());
});
