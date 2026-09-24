// Minimal service worker - just enough to satisfy "Add to Home Screen"
// installability. Not doing offline caching here on purpose: this app is
// only useful with a live connection to your backend anyway, and a caching
// layer would add complexity for no real benefit at this stage.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});

// Notifications from the server (services/pushNotify.js).
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    data = { title: 'Thakar Kitchen', body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Thakar Kitchen', {
      body: data.body || '',
      icon: '/icon.svg',
      badge: '/icon.svg',
      tag: data.tag,
      renotify: !!data.tag,
      data: { url: data.url || '/' },
    })
  );
});

// Tapping one opens the app on the right chat or page.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (new URL(w.url).origin === self.location.origin) {
          w.focus();
          return w.navigate(url);
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
