// ============================================================
//  ONLINE-ES — Service Worker v12
//  Estratégias de cache:
//    • Fontes Google        → Cache-First
//    • Assets CDN           → Cache-First
//    • /.well-known/        → NUNCA interceptado (Digital Asset Links TWA)
//    • App Shell (navigate) → Network-First + fallback cache
//    • Demais recursos      → Network-First + fallback cache
//  Background Sync:
//    • sync-rats            → reenvio de RATs salvas offline
//  Periodic Background Sync:
//    • periodic-sync-rats   → atualização periódica do widget
// ============================================================

var CACHE       = 'onlinees-v12';
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

  // ── Nunca interceptar /.well-known/ — Android/Chrome valida Digital Asset Links
  // diretamente no servidor. Se o SW interceptar e retornar do cache ou 503,
  // a verificação TWA falha e o app abre no browser em vez do app nativo. ──
  if (url.includes('/.well-known/')) return;

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

// ── Push Notifications ──────────────────────────────────────
// Recebe notificações push enviadas pelo servidor mesmo com
// o app fechado. Payload esperado (JSON):
//   { title, body, url, tag, icon }
self.addEventListener('push', function(e) {
  var data = {};
  try { data = e.data ? e.data.json() : {}; } catch(err) {}

  var title   = data.title || 'ONLINE-ES';
  var options = {
    body:    data.body  || 'Você tem uma nova notificação.',
    icon:    data.icon  || '/icons/icon-192x192.png',
    badge:   '/icons/icon-96x96.png',
    tag:     data.tag   || 'onlinees-notif',
    data:    { url: data.url || '/' },
    vibrate: [200, 100, 200],
    renotify: true,
    actions: [
      { action: 'ver',    title: 'Ver agora' },
      { action: 'fechar', title: 'Fechar'    }
    ]
  };

  e.waitUntil(self.registration.showNotification(title, options));
});

// Clique na notificação — abre ou foca a aba do app
self.addEventListener('notificationclick', function(e) {
  e.notification.close();

  if (e.action === 'fechar') return;

  var targetUrl = (e.notification.data && e.notification.data.url)
    ? e.notification.data.url
    : '/';

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(function(clients) {
        // Se já há uma aba aberta, foca ela e navega
        for (var i = 0; i < clients.length; i++) {
          if ('focus' in clients[i]) {
            clients[i].focus();
            clients[i].navigate(targetUrl);
            return;
          }
        }
        // Senão, abre nova aba
        if (self.clients.openWindow) {
          return self.clients.openWindow(targetUrl);
        }
      })
  );
});

// ── Background Sync: reenvio de RATs salvas offline ────────
// Disparado automaticamente pelo browser quando a conexão é
// restaurada após uma tentativa de salvar com falha de rede.
self.addEventListener('sync', function(e) {
  if (e.tag === 'sync-rats') {
    e.waitUntil(syncRatsPendentes());
  }
});

function syncRatsPendentes() {
  // Abre o canal de mensagem com o cliente (aba do app) para
  // que o app execute o sync real via Firestore SDK.
  return self.clients.matchAll({ type: 'window' }).then(function(clients) {
    clients.forEach(function(client) {
      client.postMessage({ type: 'SYNC_RATS_PENDENTES' });
    });
  });
}

// ── Periodic Background Sync: atualiza dados do widget ─────
// Intervalo mínimo: 15 minutos (definido no manifest via "update": 900).
// O browser decide o intervalo real com base no uso do app.
self.addEventListener('periodicsync', function(e) {
  if (e.tag === 'periodic-sync-rats') {
    e.waitUntil(atualizarDadosWidget());
  }
});

function atualizarDadosWidget() {
  // Notifica o app para atualizar os dados do widget via
  // navigator.widgets.updateByTag('rats-hoje', data)
  return self.clients.matchAll({ type: 'window' }).then(function(clients) {
    if (clients.length > 0) {
      // App está aberto — delega a atualização para ele
      clients.forEach(function(client) {
        client.postMessage({ type: 'PERIODIC_SYNC_WIDGET' });
      });
    } else {
      // App fechado — tenta buscar dados via cache e atualizar widget
      return caches.open(CACHE).then(function(cache) {
        return cache.match('/widgets/rats-hoje-data.json').then(function(resp) {
          if (resp) {
            // Dados em cache disponíveis — widget já tem conteúdo válido
            return Promise.resolve();
          }
        });
      });
    }
  });
}
