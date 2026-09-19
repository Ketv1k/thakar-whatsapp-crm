// Minimal service worker - just enough to satisfy "Add to Home Screen"
// installability. Not doing offline caching here on purpose: this app is
// only useful with a live connection to your backend anyway, and a caching
// layer would add complexity for no real benefit at this stage.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
