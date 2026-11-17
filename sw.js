// =========================================================
// SERVICE WORKER
// Um "ajudante" que o navegador roda em segundo plano para o app.
// Ele guarda os arquivos do app no celular, para abrir mesmo sem internet.
// Também é ele que recebe as notificações, mesmo com o app fechado.
// =========================================================

// Troque este número sempre que publicar uma versão nova do app,
// assim o celular descarta a cópia antiga.
const VERSAO = 'v12';
const CACHE = 'minha-eisenhower-' + VERSAO;

const ARQUIVOS_DO_APP = [
  './',
  './index.html',
  './estilo.css?v=12',
  './app.js?v=12',
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
      // cache: 'reload' = baixa do servidor de verdade, ignorando cópias antigas
      await cache.addAll(ARQUIVOS_DO_APP.map((url) => new Request(url, { cache: 'reload' })));
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

  // Bibliotecas da CDN e a fonte (Google Fonts): usa a cópia guardada
  // (elas não mudam); se não tiver, baixa e guarda para a próxima vez
  const DE_FORA = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];
  if (DE_FORA.includes(url.hostname)) {
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
  // cache: 'no-cache' = sempre pergunta ao servidor se mudou (o GitHub Pages
  // mandaria o celular usar a cópia guardada por até 10 minutos)
  evento.respondWith(
    fetch(pedido, { cache: 'no-cache' })
      .then((resposta) => {
        const copia = resposta.clone();
        caches.open(CACHE).then((cache) => cache.put(pedido, copia));
        return resposta;
      })
      .catch(() => caches.match(pedido, { ignoreSearch: true }))
  );
});

// =========================================================
// NOTIFICAÇÕES
// =========================================================

// Chegou um aviso do servidor: mostra na tela (mesmo com o app fechado)
self.addEventListener('push', (evento) => {
  let dados = {};
  try { dados = evento.data ? evento.data.json() : {}; } catch (e) { /* mensagem sem JSON */ }

  evento.waitUntil(
    self.registration.showNotification(dados.titulo || 'Lembrete', {
      body: dados.corpo || '',
      icon: 'icone-192.png',
      badge: 'icone-192.png',
      tag: dados.tarefa_id ? 'tarefa-' + dados.tarefa_id : undefined,   // mesma tarefa não empilha
      vibrate: [200, 100, 200],
      data: { tarefa_id: dados.tarefa_id },
    })
  );
});

// Tocou na notificação: abre o app (ou traz para a frente) na ficha da tarefa
self.addEventListener('notificationclick', (evento) => {
  evento.notification.close();
  const id = evento.notification.data?.tarefa_id;
  const url = new URL(id ? './?tarefa=' + id : './', self.registration.scope).href;

  evento.waitUntil((async () => {
    const janelas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const janela of janelas) {
      if (janela.url.startsWith(self.registration.scope)) {
        await janela.navigate(url);
        return janela.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});
