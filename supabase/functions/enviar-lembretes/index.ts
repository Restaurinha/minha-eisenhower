// =========================================================
// FUNÇÃO: enviar-lembretes
// Roda no servidor do Supabase. O agendador (pg_cron) chama esta
// função a cada minuto. Ela procura lembretes que já venceram e
// ainda não foram enviados, e manda a notificação para o celular.
// =========================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

// Chave PÚBLICA (pode ficar no código; é a mesma que está no app)
const VAPID_PUBLICA =
  'BKi9363Kb2uFBUmFV4DbvNQuGKSYdA2vhV4e1mPzVfDDCsoM28-kRUC5d2YN7Ed8SaY_NTnV2JWxBLI5T7vIHJ8';

// Chave PRIVADA: fica guardada nos "Secrets" do Supabase, nunca no código
const VAPID_PRIVADA = Deno.env.get('VAPID_PRIVATE_KEY') ?? '';

// Identifica quem envia (exigência do padrão de notificações)
webpush.setVapidDetails(
  'https://restaurinha.github.io/minha-eisenhower/',
  VAPID_PUBLICA,
  VAPID_PRIVADA,
);

// Lembrete vencido há mais de 2 horas não apita (evita uma enxurrada
// de avisos antigos); só é marcado como enviado.
const ATRASO_MAXIMO_MS = 2 * 60 * 60 * 1000;

Deno.serve(async () => {
  if (!VAPID_PRIVADA) {
    return Response.json({ erro: 'Falta o secret VAPID_PRIVATE_KEY' }, { status: 500 });
  }

  // Aqui usamos a chave secreta do projeto (variável automática do Supabase),
  // que enxerga as tarefas de todos os usuários. Ela só existe no servidor.
  // Projetos novos usam SUPABASE_SECRET_KEYS; os antigos, SUPABASE_SERVICE_ROLE_KEY.
  const chavesSecretas = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
  const chaveServidor = chavesSecretas['default'] ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const db = createClient(Deno.env.get('SUPABASE_URL')!, chaveServidor);

  const agora = new Date();

  // 1. Lembretes vencidos e ainda não enviados
  const { data: tarefas, error } = await db
    .from('tarefas')
    .select('id, titulo, prazo, lembrete, usuario_id')
    .lte('lembrete', agora.toISOString())
    .is('lembrete_enviado_em', null)
    .neq('status', 'concluida')
    .limit(50);

  if (error) return Response.json({ erro: error.message }, { status: 500 });

  let enviadas = 0;

  for (const tarefa of tarefas ?? []) {
    // 2. Marca como enviado ANTES de enviar, para nunca mandar duas vezes
    //    se a função for chamada de novo enquanto esta ainda roda
    await db.from('tarefas')
      .update({ lembrete_enviado_em: agora.toISOString() })
      .eq('id', tarefa.id);

    const atrasoMs = agora.getTime() - new Date(tarefa.lembrete).getTime();
    if (atrasoMs > ATRASO_MAXIMO_MS) continue;

    // 3. Todos os aparelhos inscritos do dono da tarefa
    const { data: inscricoes } = await db
      .from('push_inscricoes')
      .select('id, endpoint, p256dh, auth')
      .eq('usuario_id', tarefa.usuario_id);

    const corpo = tarefa.prazo
      ? `Prazo: ${tarefa.prazo.split('-').reverse().slice(0, 2).join('/')}`
      : 'Toque para abrir a tarefa';

    const mensagem = JSON.stringify({
      titulo: tarefa.titulo,
      corpo,
      tarefa_id: tarefa.id,
    });

    for (const inscricao of inscricoes ?? []) {
      try {
        await webpush.sendNotification(
          { endpoint: inscricao.endpoint, keys: { p256dh: inscricao.p256dh, auth: inscricao.auth } },
          mensagem,
          { TTL: 60 * 60 },   // se o celular estiver desligado, tenta entregar por até 1 hora
        );
        enviadas++;
      } catch (erro) {
        // 404/410 = o aparelho cancelou a inscrição (desinstalou, limpou dados)
        const status = (erro as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await db.from('push_inscricoes').delete().eq('id', inscricao.id);
        } else {
          console.error('Falha ao enviar para', inscricao.id, erro);
        }
      }
    }
  }

  return Response.json({ verificadas: tarefas?.length ?? 0, enviadas });
});
