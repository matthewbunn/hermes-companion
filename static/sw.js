/* Hermes Companion service worker */
const CACHE = 'hermes-shell-v2';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  // fetch with cache:'reload' so a new SW version always pulls FRESH assets,
  // never the browser's stale HTTP-cached copies.
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(SHELL.map((u) =>
      fetch(u, { cache: 'reload' }).then((r) => r.ok && c.put(u, r)).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // never cache API/auth/chat/push — always go to network
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/__') || e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then((cached) =>
      cached || fetch(e.request).then((res) => {
        if (res.ok && url.origin === location.origin) {
          const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() => cached))
  );
});

self.addEventListener('push', (e) => {
  let data = { title: 'Hermes', body: 'Notification' };
  try { data = e.data.json(); } catch { if (e.data) data.body = e.data.text(); }
  e.waitUntil(self.registration.showNotification(data.title || 'Hermes', {
    body: data.body || '', icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
    tag: data.tag || 'hermes', data: data, vibrate: [80, 40, 80],
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window' }).then((cl) => {
    for (const c of cl) if ('focus' in c) return c.focus();
    return clients.openWindow('/');
  }));
});
