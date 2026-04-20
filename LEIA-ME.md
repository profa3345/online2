# ONLINE-ES PWA — Instruções de Deploy

## Estrutura de arquivos para subir no Vercel

```
raiz-do-projeto/
├── index.html
├── portal.html
├── manifest.json
├── sw.js                          ← SERVICE WORKER (NOVO)
├── vercel.json                    ← CONFIGURAÇÃO VERCEL (NOVO)
├── .well-known/
│   └── web-app-origin-association ← SCOPE EXTENSIONS (NOVO)
└── icons/
    ├── icon-72x72.png
    ├── icon-96x96.png
    ├── icon-128x128.png
    ├── icon-144x144.png
    ├── icon-152x152.png
    ├── icon-180x180.png
    ├── icon-192x192.png
    ├── icon-384x384.png
    ├── icon-512x512.png
    ├── apple-touch-icon.png
    ├── favicon-32x32.png
    ├── favicon-16x16.png
    ├── screenshot-mobile.png
    └── screenshot-desktop.png
```

## O que cada arquivo novo faz

### `sw.js` — Service Worker
- Resolve o warning "Make your app faster and more reliable"
- Faz cache do shell do app (HTML, manifest, ícones)
- App funciona OFFLINE após primeira visita
- Firebase/Firestore nunca é interceptado (sempre vai para rede)
- Fontes e libs CDN: stale-while-revalidate

### `vercel.json` — Headers do Vercel
- Define o header `Service-Worker-Allowed: /` obrigatório
- Garante `Content-Type` correto para manifest e sw.js
- Cache otimizado para ícones (7 dias, imutable)
- Sem esse arquivo o SW pode não registrar corretamente no Vercel

### `.well-known/web-app-origin-association` — Scope Extensions
- Resolve o item "Enable your PWA to navigate to additional domains"
- Autoriza o domínio onlinees.vercel.app como origem do PWA
- Necessário para o PWABuilder reconhecer scope_extensions

## Como fazer o deploy

1. Copie os 3 arquivos novos para a raiz do seu projeto
2. Certifique-se que a pasta `.well-known/` existe com o arquivo dentro
3. Faça push/deploy normal no Vercel
4. Aguarde 1-2 minutos e teste novamente no PWABuilder

## Verificação rápida após deploy

Abra no browser:
- https://onlinees.vercel.app/sw.js              → deve mostrar o código JS
- https://onlinees.vercel.app/manifest.json      → deve mostrar o JSON
- https://onlinees.vercel.app/.well-known/web-app-origin-association → deve mostrar JSON
