// =========================================================
// SERVICE WORKER
// Um "ajudante" que o navegador roda em segundo plano para o app.
// Hoje ele só guarda a tela do app para abrir rápido.
// Mais pra frente é ele que vai receber as notificações.
// =========================================================

// Troque este número sempre que publicar uma versão nova do app,
// assim o celular descarta a cópia antiga.
const VERSAO = 'v2';
const CACHE = 'minha-eisenhower-' + VERSAO;

const ARQUIVOS_DO_APP = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icone-192.png',
  './icone-512.png',
];

// Instalação: guarda os arquivos do app
self.addEventListener('install', (evento) => {
  evento.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ARQUIVOS_DO_APP))
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

// Busca: tenta a internet primeiro; se estiver sem sinal, usa a cópia guardada.
// Só vale para os arquivos do próprio app. Os dados do Supabase
// sempre vêm direto do banco, nunca de cópia guardada.
self.addEventListener('fetch', (evento) => {
  const url = new URL(evento.request.url);
  if (evento.request.method !== 'GET' || url.origin !== self.location.origin) return;

  evento.respondWith(
    fetch(evento.request)
      .then((resposta) => {
        const copia = resposta.clone();
        caches.open(CACHE).then((cache) => cache.put(evento.request, copia));
        return resposta;
      })
      .catch(() => caches.match(evento.request))
  );
});
