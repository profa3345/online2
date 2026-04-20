/* ============================================================
   ONLINE-ES – Service Worker PWA  v3.0
   ✅ Periodic Background Sync
   ✅ Offline fallback page
   ✅ Background Sync
   ✅ Push Notifications
   ============================================================ */

const CACHE_NAME   = 'onlinees-v3';
const CACHE_FONTS  = 'onlinees-fonts-v1';
const OFFLINE_URL  = './offline.html';

const PRECACHE = [
  './index.html',
  './portal.html',
  './offline.html',
  './manifest.json',
  './icons/icon-192x192.png',
  './icons/icon-512x512.png',
  './icons/icon-384x384.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32x32.png',
  './icons/screenshot-mobile.png',
  './icons/screenshot-desktop.png',
];

const BYPASS = [
  'firestore.googleapis.com','firebase.googleapis.com',
  'identitytoolkit.googleapis.com','securetoken.googleapis.com',
  'googleapis.com','viacep.com.br','wa.me','api.whatsapp.com','telegram.me',
];
const CDN_CACHE = [
  'fonts.googleapis.com','fonts.gstatic.com',
  'cdn.jsdelivr.net','cdnjs.cloudflare.com','gstatic.com',
];

function isBypass(url) { return BYPASS.some(d => url.includes(d)); }
function isCDN(url)    { return CDN_CACHE.some(d => url.includes(d)); }

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(PRECACHE).catch(err => console.warn('[SW] Pré-cache parcial:', err))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME && k !== CACHE_FONTS).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
  self.registration.periodicSync?.register('sync-rats', { minInterval: 24 * 60 * 60 * 1000 }).catch(() => {});
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = request.url;
  if (isBypass(url)) return;

  if (isCDN(url)) {
    const cn = url.includes('fonts') ? CACHE_FONTS : CACHE_NAME;
    event.respondWith(
      caches.open(cn).then(cache =>
        cache.match(request).then(cached => {
          const net = fetch(request).then(res => {
            if (res && res.status === 200) cache.put(request, res.clone());
            return res;
          }).catch(() => cached || new Response('', { status: 204 }));
          return cached || net;
        })
      )
    );
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(res => { caches.open(CACHE_NAME).then(c => c.put(request, res.clone())); return res; })
        .catch(() => caches.match(request).then(c => c || caches.match(OFFLINE_URL)))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(res => {
        if (!res || res.status !== 200 || res.type === 'opaque') return res;
        caches.open(CACHE_NAME).then(c => c.put(request, res.clone()));
        return res;
      }).catch(() => new Response('', { status: 204 }));
    })
  );
});

self.addEventListener('periodicsync', event => {
  if (event.tag === 'sync-rats') {
    event.waitUntil(
      self.clients.matchAll().then(clients =>
        clients.forEach(c => c.postMessage({ type: 'PERIODIC_SYNC' }))
      )
    );
  }
});

self.addEventListener('sync', event => {
  if (event.tag === 'sync-rats') {
    event.waitUntil(
      self.clients.matchAll().then(clients =>
        clients.forEach(c => c.postMessage({ type: 'BACKGROUND_SYNC' }))
      )
    );
  }
});

self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json();
  self.registration.showNotification(data.title || 'ONLINE-ES', {
    body: data.body || '', icon: './icons/icon-192x192.png',
    badge: './icons/icon-96x96.png', vibrate: [200, 100, 200],
    data: { url: data.url || './' },
  });
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data.url || './'));
});
