// ============================================================
//  ONLINE-ES — Service Worker v11
//  Estratégias de cache:
//    • Fontes Google       → Cache-First
//    • Assets CDN          → Cache-First
//    • App Shell (navigate)→ Network-First + fallback cache
//    • Demais recursos     → Network-First + fallback cache
// ============================================================

var CACHE       = 'onlinees-v11';
var CACHE_FONTS = 'onlinees-fonts-v1';

var ASSETS_CDN = [
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore-compat.js',
  'https://cdn.jsdelivr.net/npm/remixicon@4.3.0/fonts/remixicon.css'
];

// ── Install: pré-cacheia assets CDN ────────────────────────
self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(cache) {
      return Promise.all(ASSETS_CDN.map(function(url) {
        return fetch(new Request(url, { mode: 'no-cors' }))
          .then(function(resp) { return cache.put(url, resp); })
          .catch(function() {}); // falha silenciosa — não bloqueia install
      }));
    }).then(function() { return self.skipWaiting(); })
  );
});

// ── Activate: limpa caches antigos ─────────────────────────
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys
        .filter(function(k) { return k !== CACHE && k !== CACHE_FONTS; })
        .map(function(k) { return caches.delete(k); }));
    }).then(function() { return self.clients.claim(); })
  );
});

// ── Fetch: estratégias por tipo de recurso ──────────────────
self.addEventListener('fetch', function(e) {
  var url    = e.request.url;
  var method = e.request.method;

  // Não intercepta: Firebase APIs, métodos não-GET
  if (method !== 'GET') return;
  if (url.includes('firestore.googleapis.com')      ||
      url.includes('identitytoolkit.googleapis.com') ||
      url.includes('firebase.googleapis.com')        ||
      url.includes('googleapis.com/v1')              ||
      url.includes('firebaseio.com')) return;

  // ── Fontes Google: Cache-First ──
  if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')) {
    e.respondWith(
      caches.open(CACHE_FONTS).then(function(cache) {
        return cache.match(e.request).then(function(cached) {
          if (cached) return cached;
          return fetch(e.request).then(function(resp) {
            if (resp && resp.status === 200) cache.put(e.request, resp.clone());
            return resp;
          }).catch(function() { return new Response('', { status: 503 }); });
        });
      })
    );
    return;
  }

  // ── Assets CDN (Firebase, remixicon): Cache-First ──
  var isCdnAsset = ASSETS_CDN.some(function(a) { return url.startsWith(a.split('?')[0]); });
  if (isCdnAsset) {
    e.respondWith(
      caches.match(e.request).then(function(cached) {
        if (cached) return cached;
        return fetch(e.request).then(function(resp) {
          if (resp && resp.status === 200) {
            var clone = resp.clone();
            caches.open(CACHE).then(function(cache) { cache.put(e.request, clone); });
          }
          return resp;
        }).catch(function() { return new Response('', { status: 503 }); });
      })
    );
    return;
  }

  // ── App Shell (index.html / navegação): Network-First com fallback cache ──
  if (e.request.mode === 'navigate' ||
      url.includes('index.html')    ||
      (!url.includes('.') && !url.includes('?rat='))) {
    e.respondWith(
      fetch(e.request).then(function(resp) {
        if (resp && resp.status === 200) {
          var clone = resp.clone();
          caches.open(CACHE).then(function(cache) { cache.put(e.request, clone); });
        }
        return resp;
      }).catch(function() {
        return caches.match(e.request)
          .then(function(c) { return c || caches.match('/') || caches.match('/index.html'); });
      })
    );
    return;
  }

  // ── Demais recursos: Network-First ──
  e.respondWith(
    fetch(e.request).then(function(resp) {
      if (resp && resp.status === 200) {
        var clone = resp.clone();
        caches.open(CACHE).then(function(cache) { cache.put(e.request, clone); });
      }
      return resp;
    }).catch(function() {
      return caches.match(e.request)
        .then(function(c) { return c || new Response('', { status: 503 }); });
    })
  );
});
