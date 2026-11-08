// S_19 CHAT BOOK — service worker (Web Push)
// ---------------------------------------------------------------------------
// Shows the notification when a message or a call arrives — even when the
// app is closed and the screen is off (data/WiFi on). The server never
// sends a message text in the push payload, only the sender's name and a
// generic Bengali line; tapping the notification opens the app, and the
// app then fetches the message / call signal the normal way (polling).

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const isCall = data.type === 'call';
  const title = data.title || 'S_19 CHAT BOOK';
  const body = data.body || (isCall ? 'কল আসছে…' : 'নতুন মেসেজ');
  const options = {
    body,
    icon: '/logo.webp',
    badge: '/logo.webp',
    tag: data.tag || (isCall ? 'call' : 'message'),
    data: { type: data.type || 'message', peer: data.peer || '' },
    requireInteraction: isCall || data.requireInteraction === true,
  };
  if (isCall) options.vibrate = [200, 100, 200];
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.indexOf(self.location.origin) === 0 && 'focus' in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow('/');
    }),
  );
});
