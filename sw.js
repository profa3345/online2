/* ============================================================
   ONLINE-ES – Service Worker PWA  v1.0
   Estratégia: Cache-first para assets estáticos,
               Network-first para Firebase/Firestore,
               Offline fallback para navegação.
   ============================================================ */

const CACHE_NAME     = 'onlinees-v1';
const PORTAL_CACHE   = 'onlinees-portal-v1';

/* Arquivos que sempre ficam em cache (shell do app) */
const SHELL_ASSETS = [
  './index.html',
  './portal.html',
  './manifest.json',
  './icons/icon-192x192.png',
  './icons/icon-512x512.png',
  './icons/apple-touch-icon.png',
  /* Adicione aqui outros CSS/JS locais se houver */
];

/* URLs que nunca devem ser interceptadas (sempre network) */
const NETWORK_ONLY = [
  'firestore.googleapis.com',
  'firebase.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'viacep.com.br',
  'wa.me',
  'api.whatsapp.com',
];

/* ── Install: pré-cache do shell ── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(SHELL_ASSETS).catch(err => {
        console.warn('[SW] Falha ao pré-cachear alguns assets:', err);
      });
    })
  );
  self.skipWaiting();
});

/* ── Activate: limpa caches antigos ── */
self.addEventListener('activate', event => {
  const validCaches = [CACHE_NAME, PORTAL_CACHE];
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => !validCaches.includes(k))
          .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

/* ── Fetch: estratégia por URL ── */
self.addEventListener('fetch', event => {
  const url = event.request.url;

  /* 1. Sempre network para Firebase, CEP, WhatsApp etc. */
  if (NETWORK_ONLY.some(domain => url.includes(domain))) {
    return; /* deixa o browser tratar normalmente */
  }

  /* 2. Navegação (HTML) → Network-first com fallback offline */
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          return res;
        })
        .catch(() =>
          caches.match(event.request).then(cached => {
            if (cached) return cached;
            /* fallback: retorna index.html do cache */
            return caches.match('./index.html');
          })
        )
    );
    return;
  }

  /* 3. Assets estáticos (JS inline, fonts CDN, ícones) → Cache-first */
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      return fetch(event.request)
        .then(res => {
          if (!res || res.status !== 200 || res.type === 'opaque') return res;
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          return res;
        })
        .catch(() => {
          /* Sem rede e sem cache: retorna 204 vazio para não quebrar */
          return new Response('', { status: 204 });
        });
    })
  );
});

/* ── Push Notifications (futuro) ── */
self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json();
  self.registration.showNotification(data.title || 'ONLINE-ES', {
    body    : data.body || '',
    icon    : './icons/icon-192x192.png',
    badge   : './icons/icon-96x96.png',
    vibrate : [200, 100, 200],
    data    : { url: data.url || './' },
  });
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(event.notification.data.url || './')
  );
});
