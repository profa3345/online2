/* ============================================================
   ONLINE-ES – Service Worker PWA  v2.0
   ✅ Passa no PWABuilder service worker check
   Estratégias:
     - Shell (HTML/manifest/ícones) → Cache-first
     - Firebase/APIs externas        → Network-only (nunca cacheia)
     - Assets CDN (fontes, libs)     → Stale-while-revalidate
     - Navegação                     → Network-first + fallback offline
   ============================================================ */

const CACHE_NAME    = 'onlinees-v2';
const OFFLINE_PAGE  = './index.html';

/* ── Assets do shell que ficam em cache imediatamente ── */
const PRECACHE = [
  './index.html',
  './portal.html',
  './manifest.json',
  './icons/icon-192x192.png',
  './icons/icon-512x512.png',
  './icons/icon-384x384.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32x32.png',
  './icons/screenshot-mobile.png',
  './icons/screenshot-desktop.png',
];

/* ── URLs que NUNCA devem ser interceptadas ── */
const BYPASS = [
  'firestore.googleapis.com',
  'firebase.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'googleapis.com',
  'viacep.com.br',
  'wa.me',
  'api.whatsapp.com',
  'telegram.me',
  'fonts.googleapis.com',   // ← CDN: tratado separado
  'fonts.gstatic.com',
];

/* ── CDN assets (fontes, libs) → stale-while-revalidate ── */
const CDN_ORIGINS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
];

function isBypass(url) {
  return BYPASS.some(d => url.includes(d));
}
function isCDN(url) {
  return CDN_ORIGINS.some(d => url.includes(d));
}

/* ── INSTALL: pré-cache do shell ── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(PRECACHE).catch(err =>
        console.warn('[SW] Pré-cache parcial:', err)
      )
    )
  );
  self.skipWaiting();
});

/* ── ACTIVATE: limpa caches antigos ── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

/* ── FETCH ── */
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = request.url;

  /* 1. Sempre deixa passar: Firebase, CEP, WhatsApp etc. */
  if (isBypass(url)) return;

  /* 2. CDN (fontes, libs) → Stale-while-revalidate */
  if (isCDN(url)) {
    event.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        cache.match(request).then(cached => {
          const network = fetch(request).then(res => {
            if (res && res.status === 200) {
              cache.put(request, res.clone());
            }
            return res;
          }).catch(() => cached || new Response('', { status: 204 }));
          return cached || network;
        })
      )
    );
    return;
  }

  /* 3. Navegação (HTML) → Network-first + fallback offline */
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(request, clone));
          return res;
        })
        .catch(() =>
          caches.match(request).then(c => c || caches.match(OFFLINE_PAGE))
        )
    );
    return;
  }

  /* 4. Outros assets locais → Cache-first */
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request)
        .then(res => {
          if (!res || res.status !== 200 || res.type === 'opaque') return res;
          caches.open(CACHE_NAME).then(c => c.put(request, res.clone()));
          return res;
        })
        .catch(() => new Response('', { status: 204 }));
    })
  );
});

/* ── PUSH Notifications ── */
self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json();
  self.registration.showNotification(data.title || 'ONLINE-ES', {
    body    : data.body  || '',
    icon    : './icons/icon-192x192.png',
    badge   : './icons/icon-96x96.png',
    vibrate : [200, 100, 200],
    data    : { url: data.url || './' },
  });
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data.url || './'));
});

/* ── SYNC (background sync futuro) ── */
self.addEventListener('sync', event => {
  if (event.tag === 'sync-rats') {
    console.log('[SW] Background sync: sync-rats');
  }
});
