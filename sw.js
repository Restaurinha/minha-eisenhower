// =========================================================
// SERVICE WORKER
// Um "ajudante" que o navegador roda em segundo plano para o app.
// Ele guarda os arquivos do app no celular, para abrir mesmo sem internet.
// Na próxima etapa, é ele que vai receber as notificações.
// =========================================================

// Troque este número sempre que publicar uma versão nova do app,
// assim o celular descarta a cópia antiga.
const VERSAO = 'v6';
const CACHE = 'minha-eisenhower-' + VERSAO;

const ARQUIVOS_DO_APP = [
  './',
  './index.html',
  './estilo.css',
  './app.js',
  './manifest.webmanifest',
  './icone-192.png',
  './icone-512.png',
];

// Bibliotecas que vêm de fora (CDN). Também guardamos, senão o app
// abriria sem internet mas quebraria por falta delas.
const BIBLIOTECAS = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://cdn.jsdelivr.net/npm/sortablejs@1.15/Sortable.min.js',
];

// Instalação: guarda os arquivos do app e as bibliotecas
self.addEventListener('install', (evento) => {
  evento.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      await cache.addAll(ARQUIVOS_DO_APP);
      // no-cors: a CDN é outro site; guardamos a resposta "fechada" mesmo assim
      await Promise.all(BIBLIOTECAS.map((url) =>
        fetch(url, { mode: 'no-cors' }).then((r) => cache.put(url, r)).catch(() => {})
      ));
    })
  );
  self.skipWaiting();
});

// Ativação: apaga caches de versões antigas
self.addEventListener('activate', (evento) => {
  evento.waitUntil(
    caches.keys().then((nomes) =>
      Promise.all(nomes.filter((n) => n !== CACHE).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (evento) => {
  const pedido = evento.request;
  if (pedido.method !== 'GET') return;
  const url = new URL(pedido.url);

  // Bibliotecas da CDN: usa a cópia guardada (elas não mudam); se não tiver, baixa
  if (url.hostname === 'cdn.jsdelivr.net') {
    evento.respondWith(
      caches.match(pedido).then((guardada) => guardada || fetch(pedido).then((resposta) => {
        const copia = resposta.clone();
        caches.open(CACHE).then((cache) => cache.put(pedido, copia));
        return resposta;
      }))
    );
    return;
  }

  // Arquivos do próprio app: tenta a internet primeiro (pega versão nova);
  // sem sinal, usa a cópia guardada.
  // Os dados do Supabase não passam por aqui: vêm sempre direto do banco.
  if (url.origin !== self.location.origin) return;
  evento.respondWith(
    fetch(pedido)
      .then((resposta) => {
        const copia = resposta.clone();
        caches.open(CACHE).then((cache) => cache.put(pedido, copia));
        return resposta;
      })
      .catch(() => caches.match(pedido, { ignoreSearch: true }))
  );
});
