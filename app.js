// =========================================================
// 1. CONEXÃO COM O BANCO
// =========================================================
const SUPABASE_URL = 'https://tiphtsjrvqexoystccmd.supabase.co';
const SUPABASE_KEY = 'sb_publishable_p8Jxumb_YDS-3D-LhS7w_w_pIUeedyR';
const db = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// ---- Estado do app ----
let areaAtual = null;        // id da área (Trabalho / Pessoal)
let abaAtual = 'captura';    // 'captura' ou 'matriz'
let categorias = [];         // categorias ativas das duas áreas
let tarefaAberta = null;     // tarefa que está na ficha
let quadranteEscolhido = null;
let cronometroAtivo = null;  // { id, tarefa_id, inicio, titulo } ou null

// Colunas que buscamos de cada tarefa
const CAMPOS_TAREFA =
  'id, titulo, descricao, quadrante, categoria_id, area_id, prazo, lembrete, ' +
  'status, origem, solicitante, recorrencia, criado_em';

const el = (id) => document.getElementById(id);


// =========================================================
// 1b. MEMÓRIA LOCAL (para funcionar sem internet)
// =========================================================
// localStorage é uma "gavetinha" do navegador que guarda texto
// mesmo depois de fechar o app. Guardamos ali:
//  - a última cópia das listas (para mostrar quando estiver sem sinal)
//  - a fila de capturas feitas sem internet (para enviar depois)
// Tudo dentro de try/catch porque em alguns casos o navegador bloqueia.

function guardarLocal(chave, valor) {
  try { localStorage.setItem(chave, JSON.stringify(valor)); } catch (e) { /* sem espaço ou bloqueado */ }
}
function lerLocal(chave, padrao) {
  try {
    const texto = localStorage.getItem(chave);
    return texto ? JSON.parse(texto) : padrao;
  } catch (e) {
    return padrao;
  }
}

// Erro de rede (sem sinal) é diferente de erro do banco (regra violada etc.)
function ehErroDeRede(erro) {
  if (!navigator.onLine) return true;
  const msg = String(erro?.message || erro || '');
  return msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('Load failed');
}


// =========================================================
// 2. FUNÇÕES DE DATA E HORA
// =========================================================
// O banco guarda data/hora em UTC. Estas funções convertem
// para o que os campos da tela entendem, no horário local.

const doisDigitos = (n) => String(n).padStart(2, '0');

// Data de hoje no formato do banco: '2026-11-16'
function hojeISO() {
  const d = new Date();
  return `${d.getFullYear()}-${doisDigitos(d.getMonth() + 1)}-${doisDigitos(d.getDate())}`;
}

// '2026-11-18' → '18/11'
function prazoCurto(prazo) {
  const [ano, mes, dia] = prazo.split('-');
  return `${dia}/${mes}`;
}

// Data/hora do banco (UTC) → valor do campo datetime-local (horário local)
function paraCampoLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${doisDigitos(d.getMonth() + 1)}-${doisDigitos(d.getDate())}` +
         `T${doisDigitos(d.getHours())}:${doisDigitos(d.getMinutes())}`;
}

// Valor do campo datetime-local → data/hora para o banco (UTC)
function doCampoLocal(valor) {
  return valor ? new Date(valor).toISOString() : null;
}

// segundos → '01:05:09' (para a barra do cronômetro)
function relogio(segundos) {
  const h = Math.floor(segundos / 3600);
  const m = Math.floor((segundos % 3600) / 60);
  const s = Math.floor(segundos % 60);
  return `${doisDigitos(h)}:${doisDigitos(m)}:${doisDigitos(s)}`;
}

// segundos → '1h 05min' ou '12 min' (para o total)
function duracao(segundos) {
  const minutos = Math.round(segundos / 60);
  if (minutos < 60) return `${minutos} min`;
  return `${Math.floor(minutos / 60)}h ${doisDigitos(minutos % 60)}min`;
}


// =========================================================
// 3. TELAS, INÍCIO E LOGIN
// =========================================================
function mostrarTela(nome) {
  el('tela-login').hidden = nome !== 'login';
  el('tela-app').hidden = nome !== 'app';
}

async function iniciar() {
  const { data } = await db.auth.getSession();
  if (data.session) {
    await abrirApp(data.session.user);
  } else {
    mostrarTela('login');
  }
}

async function abrirApp(usuario) {
  el('usuario-logado').textContent = usuario.email;
  mostrarTela('app');
  await carregarAreas();
  await carregarCategorias();
  await carregarCronometroAtivo();
  await enviarFilaOffline();   // se ficou captura presa sem internet, envia agora
  await recarregarListas();
  await atualizarEstadoNotificacoes();
  abrirTarefaDaNotificacao();
}

// Tocar numa notificação abre o app com ?tarefa=ID: abrimos a ficha dela
function abrirTarefaDaNotificacao() {
  const id = Number(new URLSearchParams(location.search).get('tarefa'));
  if (!id) return;
  history.replaceState(null, '', location.pathname);   // limpa o ?tarefa= da barra
  const tarefa = tarefasCarregadas.find((t) => t.id === id);
  if (tarefa) abrirFicha(tarefa);
}

// Quando a internet volta, o navegador avisa com o evento "online"
window.addEventListener('online', async () => {
  await enviarFilaOffline();
  await recarregarListas();
});
window.addEventListener('offline', atualizarAvisoOffline);

el('form-login').addEventListener('submit', async (evento) => {
  evento.preventDefault();
  el('btn-entrar').disabled = true;
  el('msg-login').textContent = '';

  const { data, error } = await db.auth.signInWithPassword({
    email: el('email').value.trim(),
    password: el('senha').value,
  });

  el('btn-entrar').disabled = false;
  if (error) {
    el('msg-login').textContent = 'Não consegui entrar: ' + error.message;
    console.error('Erro no login:', error);
    return;
  }
  await abrirApp(data.user);
});

el('btn-sair').addEventListener('click', async () => {
  await db.auth.signOut();
  el('barra-cronometro').hidden = true;
  mostrarTela('login');
});


// =========================================================
// 4. ÁREAS, CATEGORIAS E ABAS
// =========================================================
let areas = [];

async function carregarAreas() {
  const { data, error } = await db.from('areas').select('id, nome').order('id');
  if (error) {
    console.error('Erro ao carregar áreas:', error);
    areas = lerLocal('cache-areas', []);   // sem internet: usa a última cópia
  } else {
    areas = data;
    guardarLocal('cache-areas', data);
  }

  if (areaAtual === null && areas.length > 0) areaAtual = areas[0].id;
  desenharAreas();
}

// Desenha a área atual em dois lugares: a etiqueta do cabeçalho e o menu
function desenharAreas() {
  const atual = areas.find((a) => a.id === areaAtual);
  el('etiqueta-area').textContent = atual ? atual.nome : '';

  const lista = el('menu-areas');
  lista.innerHTML = '';
  areas.forEach((area) => {
    const botao = document.createElement('button');
    botao.type = 'button';
    botao.className = 'menu-item';
    botao.classList.toggle('ativa', area.id === areaAtual);
    const marca = document.createElement('span');
    marca.className = 'marca';
    botao.append(marca, area.nome);
    botao.addEventListener('click', () => {
      trocarArea(area.id);
      fecharMenu();
    });
    lista.appendChild(botao);
  });
}

function trocarArea(id) {
  areaAtual = id;
  desenharAreas();
  recarregarListas();
  if (abaAtual === 'indicadores') carregarIndicadores();
  if (abaAtual === 'categorias') carregarTelaCategorias();
}

// Tocar na etiqueta do cabeçalho passa para a próxima área (Trabalho ↔ Pessoal)
el('etiqueta-area').addEventListener('click', () => {
  const i = areas.findIndex((a) => a.id === areaAtual);
  trocarArea(areas[(i + 1) % areas.length].id);
});

async function carregarCategorias() {
  const { data, error } = await db
    .from('categorias')
    .select('id, nome, cor, area_id')
    .eq('ativa', true)
    .order('nome');
  if (error) {
    console.error('Erro ao carregar categorias:', error);
    categorias = lerLocal('cache-categorias', []);
    return;
  }
  categorias = data;
  guardarLocal('cache-categorias', data);
}

// Cada aba tem sua seção e o título que aparece no cabeçalho
const ABAS = {
  hoje:        'Hoje',
  captura:     'Capturar',
  matriz:      'Matriz',
  indicadores: 'Indicadores',
  categorias:  'Categorias',
};

function trocarAba(aba) {
  abaAtual = aba;
  document.querySelectorAll('#menu .menu-item[data-aba]')
    .forEach((b) => b.classList.toggle('ativa', b.dataset.aba === aba));
  Object.keys(ABAS).forEach((nome) => {
    el('secao-' + nome).hidden = nome !== aba;
  });
  el('titulo-tela').textContent = ABAS[aba];
  window.scrollTo(0, 0);
  if (aba === 'indicadores') carregarIndicadores();
  if (aba === 'categorias') carregarTelaCategorias();
}

document.querySelectorAll('#menu .menu-item[data-aba]').forEach((botao) => {
  botao.addEventListener('click', () => {
    trocarAba(botao.dataset.aba);
    fecharMenu();
  });
});

// ---- Abrir e fechar o menu lateral (no celular) ----
// Abrir = colocar a classe "aberto"; o CSS faz o menu deslizar
function abrirMenu() {
  el('menu').classList.add('aberto');
  el('menu-fundo').classList.add('aberto');
}
function fecharMenu() {
  el('menu').classList.remove('aberto');
  el('menu-fundo').classList.remove('aberto');
}
el('btn-menu').addEventListener('click', abrirMenu);
el('menu-fundo').addEventListener('click', fecharMenu);  // tocar fora fecha

trocarAba('captura');  // tela inicial


// =========================================================
// 5. CAPTURA RÁPIDA
// =========================================================
el('form-captura').addEventListener('submit', async (evento) => {
  evento.preventDefault();
  const titulo = el('titulo').value.trim();
  if (!titulo) return;

  el('btn-salvar').disabled = true;
  el('msg-captura').className = 'msg';
  el('msg-captura').textContent = 'Salvando...';

  // Guardamos a hora real da captura, para não perder quando for enviada depois
  const captura = { titulo, area_id: areaAtual, criado_em: new Date().toISOString() };

  let error = null;
  try {
    ({ error } = await db.from('tarefas').insert(captura));
  } catch (e) {
    error = e;   // sem internet, às vezes o erro vem "lançado" em vez de devolvido
  }

  el('btn-salvar').disabled = false;

  // Sem sinal: guarda no celular e avisa
  if (error && ehErroDeRede(error)) {
    const fila = lerLocal('fila-offline', []);
    fila.push(captura);
    guardarLocal('fila-offline', fila);
    el('titulo').value = '';
    el('msg-captura').textContent = 'Sem internet: guardado no celular, envio quando o sinal voltar.';
    atualizarAvisoOffline();
    mostrarFilaNaCaixa();
    return;
  }

  if (error) {
    el('msg-captura').className = 'msg erro';
    el('msg-captura').textContent = 'Erro ao salvar: ' + error.message;
    return console.error('Erro ao salvar tarefa:', error);
  }

  el('titulo').value = '';
  el('msg-captura').textContent = 'Salvo!';
  setTimeout(() => (el('msg-captura').textContent = ''), 1500);
  el('titulo').focus();
  await recarregarListas();
});

// Envia as capturas guardadas sem internet, uma por uma.
// A que der certo sai da fila; se a rede cair no meio, o resto fica para depois.
async function enviarFilaOffline() {
  const fila = lerLocal('fila-offline', []);
  if (fila.length === 0) return atualizarAvisoOffline();

  const sobraram = [];
  for (const captura of fila) {
    try {
      const { error } = await db.from('tarefas').insert(captura);
      if (error) sobraram.push(captura);
    } catch (e) {
      sobraram.push(captura);
    }
  }
  guardarLocal('fila-offline', sobraram);
  atualizarAvisoOffline();
}

function atualizarAvisoOffline() {
  const pendentes = lerLocal('fila-offline', []).length;
  const aviso = el('aviso-offline');
  if (!navigator.onLine) {
    aviso.textContent = 'Sem internet. Você pode capturar normalmente: guardo no celular e envio depois.' +
      (pendentes ? ` (${pendentes} esperando envio)` : '');
    aviso.hidden = false;
  } else if (pendentes) {
    aviso.textContent = `${pendentes} captura(s) esperando envio...`;
    aviso.hidden = false;
  } else {
    aviso.hidden = true;
  }
}

// Mostra no topo da caixa de entrada o que ainda está só no celular
function mostrarFilaNaCaixa() {
  const lista = el('lista-caixa');
  lista.querySelectorAll('.pendente-envio').forEach((li) => li.remove());
  lerLocal('fila-offline', [])
    .filter((c) => c.area_id === areaAtual)
    .reverse()
    .forEach((c) => {
      lista.querySelector('.vazio')?.remove();
      const item = document.createElement('li');
      item.className = 'tarefa pendente-envio';
      item.textContent = c.titulo;
      const detalhe = document.createElement('small');
      detalhe.textContent = 'aguardando internet para enviar';
      item.appendChild(detalhe);
      lista.prepend(item);
    });
}


// =========================================================
// 6. LISTAS: CAIXA DE ENTRADA E MATRIZ
// =========================================================
let tarefasCarregadas = [];   // última lista, usada pelo arrastar e soltar

async function recarregarListas() {
  let tarefas;
  let resposta = { data: null, error: null };
  try {
    resposta = await db
      .from('tarefas')
      .select(CAMPOS_TAREFA)
      .neq('status', 'concluida')
      .or(`area_id.eq.${areaAtual},area_id.is.null`)
      .order('criado_em', { ascending: false });
  } catch (e) {
    resposta.error = e;
  }

  if (resposta.error) {
    console.error('Erro ao carregar tarefas:', resposta.error);
    // Sem internet: mostra a última cópia guardada desta área
    tarefas = lerLocal('cache-tarefas-' + areaAtual, []);
  } else {
    tarefas = resposta.data;
    guardarLocal('cache-tarefas-' + areaAtual, tarefas);
  }
  tarefasCarregadas = tarefas;
  atualizarAvisoOffline();

  // Caixa de entrada: sem quadrante, mais recentes primeiro
  const caixa = tarefas.filter((t) => t.quadrante === null);
  el('contador').textContent = caixa.length === 1 ? '1 item' : `${caixa.length} itens`;
  preencherLista(el('lista-caixa'), caixa, 'Nada pendente aqui.');
  mostrarFilaNaCaixa();

  // Matriz: a faixa "Sem quadrante" (0) + os 4 quadrantes,
  // ordenados pelo prazo mais próximo; sem prazo vai para o fim
  const porPrazo = (a, b) => (a.prazo || '9999-12-31').localeCompare(b.prazo || '9999-12-31');
  for (let q = 0; q <= 4; q++) {
    const doQuadrante = tarefas
      .filter((t) => (q === 0 ? t.quadrante === null : t.quadrante === q))
      .sort(porPrazo);
    el('cont-' + q).textContent = doQuadrante.length || '';
    preencherLista(el('lista-q' + q), doQuadrante, q === 0 ? 'Tudo classificado 👍' : 'Vazio');
  }

  // A tela Hoje usa as mesmas tarefas, só filtra de outro jeito
  renderizarHoje(tarefas);
}

// =========================================================
// 6b. TELA HOJE
// =========================================================
function renderizarHoje(tarefas) {
  const hoje = hojeISO();
  const jaListadas = new Set();   // para não repetir a mesma tarefa em dois blocos

  const atrasadas = tarefas.filter((t) => t.prazo && t.prazo < hoje);
  const vencem = tarefas.filter((t) => t.prazo === hoje);
  [...atrasadas, ...vencem].forEach((t) => jaListadas.add(t.id));

  // Lembretes cujo dia (no horário local) é hoje, em ordem de hora
  const lembretes = tarefas
    .filter((t) => t.lembrete && paraCampoLocal(t.lembrete).slice(0, 10) === hoje)
    .sort((a, b) => a.lembrete.localeCompare(b.lembrete));

  // Quadrante 1 que ainda não apareceu acima
  const fazer = tarefas.filter((t) => t.quadrante === 1 && !jaListadas.has(t.id));

  const blocos = [
    ['atrasadas', atrasadas, 'Nada atrasado.'],
    ['vencem', vencem, 'Nada vence hoje.'],
    ['lembretes', lembretes, 'Sem lembretes hoje.'],
    ['fazer', fazer, 'Nada no "Fazer agora".'],
  ];
  blocos.forEach(([nome, lista, vazio]) => {
    el('cont-' + nome).textContent = lista.length || '';
    preencherLista(el('lista-' + nome), lista, vazio);
  });

  // Nos lembretes, mostra a hora em destaque no canto do item
  el('lista-lembretes').querySelectorAll('li.tarefa').forEach((item, i) => {
    const hora = document.createElement('span');
    hora.className = 'hora';
    hora.textContent = paraCampoLocal(lembretes[i].lembrete).slice(11, 16);
    item.prepend(hora);
  });
}

function preencherLista(lista, tarefas, textoVazio) {
  lista.innerHTML = '';

  if (tarefas.length === 0) {
    lista.innerHTML = `<li class="vazio">${textoVazio}</li>`;
    return;
  }

  const hoje = hojeISO();

  tarefas.forEach((tarefa) => {
    const item = document.createElement('li');
    item.className = 'tarefa';
    item.dataset.id = tarefa.id;   // o arrastar e soltar usa isso para saber qual tarefa é
    if (cronometroAtivo && cronometroAtivo.tarefa_id === tarefa.id) {
      item.classList.add('rodando');
    }

    const categoria = categorias.find((c) => c.id === tarefa.categoria_id);
    if (categoria) {
      const bolinha = document.createElement('span');
      bolinha.className = 'bolinha';
      bolinha.style.background = categoria.cor || 'var(--suave)';
      item.appendChild(bolinha);
    }

    item.appendChild(document.createTextNode(tarefa.titulo));

    // Linha de detalhe: categoria · prazo · status
    const detalhe = document.createElement('small');
    const partes = [];
    if (tarefa.recorrencia) partes.push('↻');
    if (categoria) partes.push(categoria.nome);
    if (tarefa.status === 'aguardando_terceiro') partes.push('aguardando');
    if (tarefa.status === 'em_andamento') partes.push('em andamento');
    if (!tarefa.prazo) {
      partes.push(new Date(tarefa.criado_em)
        .toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }));
    }
    detalhe.textContent = partes.join(' · ');

    if (tarefa.prazo) {
      const prazo = document.createElement('span');
      const atrasada = tarefa.prazo < hoje;  // datas 'AAAA-MM-DD' comparam como texto
      prazo.textContent = (partes.length ? ' · ' : '') +
        (atrasada ? 'atrasada ' : tarefa.prazo === hoje ? 'vence hoje ' : 'vence ') +
        prazoCurto(tarefa.prazo);
      if (atrasada || tarefa.prazo === hoje) prazo.className = 'atrasada';
      detalhe.appendChild(prazo);
    }

    item.appendChild(detalhe);
    item.addEventListener('click', () => abrirFicha(tarefa));
    lista.appendChild(item);
  });
}


// =========================================================
// 7. FICHA DA TAREFA
// =========================================================
async function abrirFicha(tarefa) {
  tarefaAberta = tarefa;
  quadranteEscolhido = tarefa.quadrante;
  el('dlg-msg').textContent = '';

  el('dlg-titulo').value = tarefa.titulo;
  el('dlg-descricao').value = tarefa.descricao ?? '';
  el('dlg-prazo').value = tarefa.prazo ?? '';
  el('dlg-lembrete').value = paraCampoLocal(tarefa.lembrete);
  el('dlg-status').value = tarefa.status;
  el('dlg-origem').value = tarefa.origem;
  el('dlg-solicitante').value = tarefa.solicitante ?? '';
  el('bloco-solicitante').hidden = tarefa.origem !== 'terceiro';
  el('dlg-recorrencia').value = tarefa.recorrencia ?? '';
  el('dica-recorrencia').hidden = !tarefa.recorrencia;

  // Categorias da área da tarefa
  const area = tarefa.area_id ?? areaAtual;
  const select = el('dlg-categoria');
  select.innerHTML = '<option value="">Sem categoria</option>';
  categorias
    .filter((c) => c.area_id === area)
    .forEach((c) => {
      const opcao = document.createElement('option');
      opcao.value = c.id;
      opcao.textContent = c.nome;
      select.appendChild(opcao);
    });
  select.value = tarefa.categoria_id ?? '';

  marcarQuadrante();
  el('dlg-subtarefas').innerHTML = '';
  el('dlg-tempo-total').textContent = '...';
  atualizarBotaoPlay();
  el('dlg-tarefa').showModal();

  // Estes dois vêm de outras tabelas, então carregam depois de abrir
  await Promise.all([carregarSubtarefas(), carregarTempoTotal()]);
}

function marcarQuadrante() {
  document.querySelectorAll('#dlg-quadrantes button').forEach((b) => {
    b.classList.toggle('ativa', Number(b.dataset.q) === quadranteEscolhido);
  });
}

document.querySelectorAll('#dlg-quadrantes button').forEach((botao) => {
  botao.addEventListener('click', () => {
    const q = Number(botao.dataset.q);
    quadranteEscolhido = quadranteEscolhido === q ? null : q;
    marcarQuadrante();
  });
});

// Mostra o campo "Quem pediu?" só quando a origem é de terceiro
el('dlg-origem').addEventListener('change', () => {
  el('bloco-solicitante').hidden = el('dlg-origem').value !== 'terceiro';
});
el('dlg-recorrencia').addEventListener('change', () => {
  el('dica-recorrencia').hidden = !el('dlg-recorrencia').value;
});

async function atualizarTarefa(campos) {
  const { error } = await db.from('tarefas').update(campos).eq('id', tarefaAberta.id);
  if (error) {
    el('dlg-msg').textContent = 'Erro: ' + error.message;
    console.error('Erro ao atualizar tarefa:', error);
    return false;
  }
  el('dlg-tarefa').close();
  await recarregarListas();
  return true;
}

el('dlg-salvar').addEventListener('click', () => {
  const titulo = el('dlg-titulo').value.trim();
  if (!titulo) {
    el('dlg-msg').textContent = 'O título não pode ficar vazio.';
    return;
  }
  const categoriaId = el('dlg-categoria').value;
  const origem = el('dlg-origem').value;
  const lembrete = doCampoLocal(el('dlg-lembrete').value);

  const campos = {
    titulo,
    descricao: el('dlg-descricao').value.trim() || null,
    categoria_id: categoriaId ? Number(categoriaId) : null,
    quadrante: quadranteEscolhido,
    area_id: tarefaAberta.area_id ?? areaAtual,
    prazo: el('dlg-prazo').value || null,
    lembrete,
    status: el('dlg-status').value,
    origem,
    solicitante: origem === 'terceiro' ? (el('dlg-solicitante').value.trim() || null) : null,
    recorrencia: el('dlg-recorrencia').value || null,
  };

  // Mudou o horário do lembrete? Então ele precisa poder apitar de novo.
  // (comparamos como data, porque o banco e o campo escrevem a hora de jeitos diferentes)
  const antes = tarefaAberta.lembrete ? new Date(tarefaAberta.lembrete).getTime() : null;
  const depois = lembrete ? new Date(lembrete).getTime() : null;
  if (antes !== depois) campos.lembrete_enviado_em = null;

  atualizarTarefa(campos);
});

el('dlg-concluir').addEventListener('click', async () => {
  // Se o cronômetro está nesta tarefa, para antes de concluir
  if (cronometroAtivo && cronometroAtivo.tarefa_id === tarefaAberta.id) {
    await pararCronometro();
  }
  const tarefa = tarefaAberta;   // guarda antes de fechar a ficha
  const ok = await atualizarTarefa({
    status: 'concluida',
    concluido_em: new Date().toISOString(),
  });
  if (ok && tarefa.recorrencia) await criarProximaOcorrencia(tarefa);
});


// =========================================================
// 7b. TAREFAS RECORRENTES
// =========================================================
// Ao concluir uma tarefa que repete, criamos a próxima: mesma tarefa,
// com prazo e lembrete empurrados para a próxima data.

// Soma dias a uma data 'AAAA-MM-DD' e devolve no mesmo formato
function somarDias(dataISO, dias) {
  const d = new Date(dataISO + 'T12:00:00');   // meio-dia evita problema de fuso
  d.setDate(d.getDate() + dias);
  return `${d.getFullYear()}-${doisDigitos(d.getMonth() + 1)}-${doisDigitos(d.getDate())}`;
}

// Próxima data a partir da base, conforme o tipo de repetição
function proximaData(base, recorrencia) {
  if (recorrencia === 'diaria') return somarDias(base, 1);
  if (recorrencia === 'semanal') return somarDias(base, 7);
  if (recorrencia === 'dias_uteis') {
    let proxima = somarDias(base, 1);
    // 0 = domingo, 6 = sábado: pula o fim de semana
    while ([0, 6].includes(new Date(proxima + 'T12:00:00').getDay())) {
      proxima = somarDias(proxima, 1);
    }
    return proxima;
  }
  if (recorrencia === 'mensal') {
    const [ano, mes, dia] = base.split('-').map(Number);
    // Dia 31 num mês de 30 dias vira o último dia do mês
    const ultimoDia = new Date(ano, mes + 1, 0).getDate();   // mes já é o "próximo" (base 0)
    const proximoMes = new Date(ano, mes, Math.min(dia, ultimoDia), 12);
    return `${proximoMes.getFullYear()}-${doisDigitos(proximoMes.getMonth() + 1)}-${doisDigitos(proximoMes.getDate())}`;
  }
  return base;
}

async function criarProximaOcorrencia(tarefa) {
  // A base é o prazo; se não tiver, conta a partir de hoje
  const base = tarefa.prazo || hojeISO();
  let proximoPrazo = proximaData(base, tarefa.recorrencia);
  // Se a tarefa estava muito atrasada, não cria a próxima já vencida
  while (proximoPrazo < hojeISO()) proximoPrazo = proximaData(proximoPrazo, tarefa.recorrencia);

  // O lembrete anda a mesma quantidade de dias que o prazo andou
  let proximoLembrete = null;
  if (tarefa.lembrete) {
    const diasAndados = Math.round(
      (new Date(proximoPrazo + 'T12:00:00') - new Date(base + 'T12:00:00')) / 86400000
    );
    const lembrete = new Date(tarefa.lembrete);
    lembrete.setDate(lembrete.getDate() + diasAndados);
    proximoLembrete = lembrete.toISOString();
  }

  const { data: nova, error } = await db.from('tarefas').insert({
    titulo: tarefa.titulo,
    descricao: tarefa.descricao,
    area_id: tarefa.area_id ?? areaAtual,
    categoria_id: tarefa.categoria_id,
    quadrante: tarefa.quadrante,
    origem: tarefa.origem,
    solicitante: tarefa.solicitante,
    recorrencia: tarefa.recorrencia,
    prazo: tarefa.prazo ? proximoPrazo : null,
    lembrete: proximoLembrete,
  }).select('id').single();
  if (error) return console.error('Erro ao criar próxima ocorrência:', error);

  // Copia o checklist, tudo desmarcado
  const { data: subs } = await db.from('subtarefas')
    .select('texto, ordem').eq('tarefa_id', tarefa.id);
  if (subs && subs.length) {
    await db.from('subtarefas').insert(
      subs.map((s) => ({ tarefa_id: nova.id, texto: s.texto, ordem: s.ordem }))
    );
  }
  await recarregarListas();
}

el('dlg-apagar').addEventListener('click', async () => {
  if (!confirm('Apagar esta pendência de vez? Subtarefas e tempos dela também somem.')) return;
  if (cronometroAtivo && cronometroAtivo.tarefa_id === tarefaAberta.id) {
    cronometroAtivo = null;
    mostrarBarraCronometro();
  }
  const { error } = await db.from('tarefas').delete().eq('id', tarefaAberta.id);
  if (error) {
    el('dlg-msg').textContent = 'Erro ao apagar: ' + error.message;
    return console.error('Erro ao apagar tarefa:', error);
  }
  el('dlg-tarefa').close();
  await recarregarListas();
});

el('dlg-cancelar').addEventListener('click', () => el('dlg-tarefa').close());

// Apertar Enter num campo da ficha não fecha a janela sem salvar
el('form-tarefa').addEventListener('submit', (evento) => evento.preventDefault());


// =========================================================
// 8. SUBTAREFAS (gravam na hora, sem precisar de "Salvar")
// =========================================================
async function carregarSubtarefas() {
  const { data, error } = await db
    .from('subtarefas')
    .select('id, texto, feita, ordem')
    .eq('tarefa_id', tarefaAberta.id)
    .order('ordem')
    .order('id');
  if (error) return console.error('Erro ao carregar subtarefas:', error);

  const lista = el('dlg-subtarefas');
  lista.innerHTML = '';

  data.forEach((sub) => {
    const item = document.createElement('li');
    item.classList.toggle('feita', sub.feita);

    const caixa = document.createElement('input');
    caixa.type = 'checkbox';
    caixa.checked = sub.feita;
    caixa.addEventListener('change', async () => {
      item.classList.toggle('feita', caixa.checked);
      const { error } = await db.from('subtarefas')
        .update({ feita: caixa.checked }).eq('id', sub.id);
      if (error) console.error('Erro ao marcar subtarefa:', error);
    });

    const texto = document.createElement('span');
    texto.textContent = sub.texto;

    const apagar = document.createElement('button');
    apagar.type = 'button';
    apagar.textContent = '×';
    apagar.setAttribute('aria-label', 'Apagar subtarefa');
    apagar.addEventListener('click', async () => {
      const { error } = await db.from('subtarefas').delete().eq('id', sub.id);
      if (error) return console.error('Erro ao apagar subtarefa:', error);
      item.remove();
    });

    item.append(caixa, texto, apagar);
    lista.appendChild(item);
  });
}

async function adicionarSubtarefa() {
  const texto = el('dlg-nova-sub').value.trim();
  if (!texto) return;

  const ordem = el('dlg-subtarefas').children.length;
  const { error } = await db.from('subtarefas')
    .insert({ tarefa_id: tarefaAberta.id, texto, ordem });
  if (error) {
    el('dlg-msg').textContent = 'Erro ao adicionar subtarefa: ' + error.message;
    return console.error('Erro ao adicionar subtarefa:', error);
  }
  el('dlg-nova-sub').value = '';
  el('dlg-nova-sub').focus();
  await carregarSubtarefas();
}

el('dlg-add-sub').addEventListener('click', adicionarSubtarefa);
el('dlg-nova-sub').addEventListener('keydown', (evento) => {
  if (evento.key === 'Enter') {
    evento.preventDefault();  // Enter adiciona, em vez de enviar a ficha
    adicionarSubtarefa();
  }
});


// =========================================================
// 9. CRONÔMETRO (play / pause)
// =========================================================
// Regra do banco: só pode existir UM registro com fim vazio.
// Por isso, dar play numa tarefa sempre pausa a anterior antes.

async function carregarCronometroAtivo() {
  // tarefas(titulo) traz o título da tarefa junto, pela chave estrangeira
  const { data, error } = await db
    .from('registros_tempo')
    .select('id, tarefa_id, inicio, tarefas(titulo)')
    .is('fim', null)
    .maybeSingle();
  if (error) return console.error('Erro ao ler cronômetro:', error);

  cronometroAtivo = data
    ? { id: data.id, tarefa_id: data.tarefa_id, inicio: data.inicio, titulo: data.tarefas?.titulo }
    : null;
  mostrarBarraCronometro();
}

async function iniciarCronometro(tarefaId) {
  await pararCronometro();
  const { error } = await db.from('registros_tempo').insert({ tarefa_id: tarefaId });
  if (error) {
    el('dlg-msg').textContent = 'Erro ao iniciar cronômetro: ' + error.message;
    return console.error('Erro ao iniciar cronômetro:', error);
  }
  await carregarCronometroAtivo();
}

async function pararCronometro() {
  if (!cronometroAtivo) return;
  const { error } = await db.from('registros_tempo')
    .update({ fim: new Date().toISOString() })
    .eq('id', cronometroAtivo.id);
  if (error) return console.error('Erro ao pausar cronômetro:', error);
  cronometroAtivo = null;
  mostrarBarraCronometro();
}

// Barra verde no topo + relógio que anda a cada segundo
let intervaloRelogio = null;
function mostrarBarraCronometro() {
  clearInterval(intervaloRelogio);
  el('barra-cronometro').hidden = !cronometroAtivo;
  if (!cronometroAtivo) return;

  el('cron-titulo').textContent = cronometroAtivo.titulo ?? 'Tarefa';
  const tique = () => {
    const segundos = (Date.now() - new Date(cronometroAtivo.inicio)) / 1000;
    el('cron-tempo').textContent = relogio(segundos);
  };
  tique();
  intervaloRelogio = setInterval(tique, 1000);
}

el('cron-pausar').addEventListener('click', async () => {
  await pararCronometro();
  await recarregarListas();
});

// Soma todos os intervalos da tarefa aberta (o que está rodando conta até agora)
async function carregarTempoTotal() {
  const { data, error } = await db
    .from('registros_tempo')
    .select('inicio, fim')
    .eq('tarefa_id', tarefaAberta.id);
  if (error) return console.error('Erro ao somar tempo:', error);

  const segundos = data.reduce((soma, r) => {
    const fim = r.fim ? new Date(r.fim) : new Date();
    return soma + (fim - new Date(r.inicio)) / 1000;
  }, 0);
  el('dlg-tempo-total').textContent = duracao(segundos);
}

function atualizarBotaoPlay() {
  const rodandoAqui = cronometroAtivo && cronometroAtivo.tarefa_id === tarefaAberta.id;
  el('dlg-play').textContent = rodandoAqui ? '⏸ Pausar' : '▶ Iniciar';
  el('dlg-play').classList.toggle('pausar', rodandoAqui);
}

el('dlg-play').addEventListener('click', async () => {
  el('dlg-play').disabled = true;
  const rodandoAqui = cronometroAtivo && cronometroAtivo.tarefa_id === tarefaAberta.id;

  if (rodandoAqui) {
    await pararCronometro();
  } else {
    await iniciarCronometro(tarefaAberta.id);
  }

  el('dlg-play').disabled = false;
  atualizarBotaoPlay();
  await carregarTempoTotal();
  await recarregarListas();
});


// =========================================================
// 10. INDICADORES
// =========================================================
let diasPeriodo = 7;

document.querySelectorAll('#chave-periodos button').forEach((botao) => {
  botao.addEventListener('click', () => {
    diasPeriodo = Number(botao.dataset.dias);
    document.querySelectorAll('#chave-periodos button')
      .forEach((b) => b.classList.toggle('ativa', b === botao));
    carregarIndicadores();
  });
});

// Início do período: meia-noite de hoje, menos N dias (no horário local)
function inicioPeriodo() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - diasPeriodo);
  return d.toISOString();
}

// Tarefa sem área conta junto com a área atual (ainda está na caixa de entrada)
const daAreaAtual = (areaId) => areaId === null || areaId === areaAtual;

async function carregarIndicadores() {
  const desde = inicioPeriodo();

  // As duas consultas são independentes, então rodam ao mesmo tempo
  const [tempos, concluidas] = await Promise.all([
    db.from('registros_tempo')
      .select('inicio, fim, tarefas(categoria_id, area_id, origem, solicitante)')
      .gte('inicio', desde),
    db.from('tarefas')
      .select('id, titulo, criado_em, concluido_em, categoria_id, area_id')
      .eq('status', 'concluida')
      .gte('concluido_em', desde)
      .order('concluido_em', { ascending: false }),
  ]);

  if (tempos.error) return console.error('Erro ao ler tempos:', tempos.error);
  if (concluidas.error) return console.error('Erro ao ler concluídas:', concluidas.error);

  // ---------- Tempo ----------
  // Cada registro vira { segundos, tarefa }; o que está rodando conta até agora
  const registros = tempos.data
    .filter((r) => r.tarefas && daAreaAtual(r.tarefas.area_id))
    .map((r) => ({
      segundos: ((r.fim ? new Date(r.fim) : new Date()) - new Date(r.inicio)) / 1000,
      tarefa: r.tarefas,
    }));

  const total = registros.reduce((soma, r) => soma + r.segundos, 0);
  el('ind-tempo').textContent = total ? duracao(total) : '0 min';

  // Soma por categoria (é um "agrupar por" + "soma", como numa tabela dinâmica)
  const porCategoria = new Map();
  registros.forEach((r) => {
    const chave = r.tarefa.categoria_id ?? 'sem';
    porCategoria.set(chave, (porCategoria.get(chave) || 0) + r.segundos);
  });
  const itensCategoria = [...porCategoria].map(([id, segundos]) => {
    const cat = categorias.find((c) => c.id === id);
    return {
      nome: cat ? cat.nome : 'Sem categoria',
      cor: cat?.cor || 'var(--q4)',
      segundos,
    };
  });
  desenharBarras(el('ind-categorias'), itensCategoria, total);

  // Soma por origem: minhas x de cada pessoa que pediu
  const porOrigem = new Map();
  let deTerceiros = 0;
  registros.forEach((r) => {
    let chave = 'Minhas demandas';
    if (r.tarefa.origem === 'terceiro') {
      chave = 'Pedido de: ' + (r.tarefa.solicitante || 'não informado');
      deTerceiros += r.segundos;
    }
    porOrigem.set(chave, (porOrigem.get(chave) || 0) + r.segundos);
  });
  const itensOrigem = [...porOrigem].map(([nome, segundos]) => ({
    nome,
    segundos,
    cor: nome === 'Minhas demandas' ? 'var(--q2)' : 'var(--q3)',
  }));
  desenharBarras(el('ind-origem'), itensOrigem, total);
  el('ind-terceiros').textContent = total ? Math.round((deTerceiros / total) * 100) + '%' : '–';

  // ---------- Concluídas ----------
  const lista = concluidas.data.filter((t) => daAreaAtual(t.area_id));
  el('ind-concluidas').textContent = lista.length;

  const MS_POR_DIA = 24 * 60 * 60 * 1000;
  const dias = lista.map((t) => (new Date(t.concluido_em) - new Date(t.criado_em)) / MS_POR_DIA);
  const media = dias.length ? dias.reduce((a, b) => a + b, 0) / dias.length : null;
  el('ind-lead').textContent = media === null
    ? '–'
    : media.toLocaleString('pt-BR', { maximumFractionDigits: 1 });

  preencherConcluidas(lista);
}

// Barras horizontais ordenadas da maior para a menor
function desenharBarras(container, itens, total) {
  container.innerHTML = '';
  if (!total) {
    container.innerHTML = '<p class="vazio">Nenhum tempo registrado no período. Use o ▶ na ficha da tarefa.</p>';
    return;
  }
  const maior = Math.max(...itens.map((i) => i.segundos));

  itens
    .sort((a, b) => b.segundos - a.segundos)
    .forEach((item) => {
      const linha = document.createElement('div');
      linha.className = 'barra-linha';

      const cabeca = document.createElement('div');
      cabeca.className = 'cabeca';
      const nome = document.createElement('span');
      nome.textContent = item.nome;
      const valor = document.createElement('span');
      valor.textContent = `${duracao(item.segundos)} · ${Math.round((item.segundos / total) * 100)}%`;
      cabeca.append(nome, valor);

      const trilho = document.createElement('div');
      trilho.className = 'barra-trilho';
      const preenchida = document.createElement('div');
      preenchida.className = 'barra-preenchida';
      preenchida.style.width = (item.segundos / maior) * 100 + '%';
      preenchida.style.background = item.cor;
      trilho.appendChild(preenchida);

      linha.append(cabeca, trilho);
      container.appendChild(linha);
    });
}

function preencherConcluidas(tarefas) {
  const lista = el('ind-lista-concluidas');
  lista.innerHTML = '';
  if (tarefas.length === 0) {
    lista.innerHTML = '<li class="vazio">Nenhuma tarefa concluída no período.</li>';
    return;
  }

  tarefas.forEach((tarefa) => {
    const item = document.createElement('li');
    item.className = 'tarefa';
    item.textContent = tarefa.titulo;

    const detalhe = document.createElement('small');
    const quando = new Date(tarefa.concluido_em)
      .toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const cat = categorias.find((c) => c.id === tarefa.categoria_id);
    detalhe.textContent = (cat ? cat.nome + ' · ' : '') + 'concluída ' + quando;
    item.appendChild(detalhe);

    item.addEventListener('click', async () => {
      if (!confirm(`Reabrir "${tarefa.titulo}"?`)) return;
      const { error } = await db.from('tarefas')
        .update({ status: 'aberta', concluido_em: null })
        .eq('id', tarefa.id);
      if (error) return console.error('Erro ao reabrir tarefa:', error);
      await recarregarListas();
      await carregarIndicadores();
    });

    lista.appendChild(item);
  });
}


// =========================================================
// 10b. FORMATO DA MATRIZ (Quadros ou Lista)
// =========================================================
// Não existem duas matrizes: é o mesmo HTML com uma classe a mais.
// "modo-lista" na div #matriz faz o CSS desenhar tudo em uma coluna.
// A escolha fica guardada no celular para a próxima vez.

function aplicarFormatoMatriz(formato) {
  el('matriz').classList.toggle('modo-lista', formato === 'lista');
  document.querySelectorAll('#formato-matriz button')
    .forEach((b) => b.classList.toggle('ativa', b.dataset.formato === formato));
  guardarLocal('formato-matriz', formato);
}

document.querySelectorAll('#formato-matriz button').forEach((botao) => {
  botao.addEventListener('click', () => aplicarFormatoMatriz(botao.dataset.formato));
});

// No formato Lista, tocar no cabeçalho do quadrante abre/fecha a lista.
// Os quadrantes fechados também ficam guardados.
const fechados = new Set(lerLocal('quadrantes-fechados', []));

document.querySelectorAll('.quadrante').forEach((quadrante) => {
  const q = Number(quadrante.dataset.q);
  const botao = quadrante.querySelector('.cabeca-quadrante');
  const desenhar = () => {
    quadrante.classList.toggle('fechado', fechados.has(q));
    botao.setAttribute('aria-expanded', String(!fechados.has(q)));
  };
  desenhar();

  botao.addEventListener('click', () => {
    if (!el('matriz').classList.contains('modo-lista')) return;   // na grade não fecha
    fechados.has(q) ? fechados.delete(q) : fechados.add(q);
    guardarLocal('quadrantes-fechados', [...fechados]);
    desenhar();
  });
});

aplicarFormatoMatriz(lerLocal('formato-matriz', 'quadros'));


// =========================================================
// 10c. SAUDAÇÃO E ATUALIZAÇÃO AUTOMÁTICA
// =========================================================
const NOME_USUARIO = 'Leonardo';

function atualizarSaudacao() {
  const hora = new Date().getHours();
  const periodo = hora < 12 ? 'Bom dia' : hora < 18 ? 'Boa tarde' : 'Boa noite';
  el('saudacao').textContent = `${periodo}, ${NOME_USUARIO}`;
}
atualizarSaudacao();

// Sem o "puxar para recarregar", o app se atualiza sozinho quando você
// volta para ele (troca de app, desbloqueia o celular...).
// "visibilitychange" dispara quando a tela do app aparece ou some.
let ultimaAtualizacao = Date.now();
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;
  if (el('tela-app').hidden) return;                       // ainda no login
  if (el('dlg-tarefa').open) return;                       // não atrapalha quem está editando
  if (Date.now() - ultimaAtualizacao < 30 * 1000) return;  // no máximo a cada 30 s
  ultimaAtualizacao = Date.now();
  atualizarSaudacao();
  await enviarFilaOffline();
  await carregarCronometroAtivo();
  await recarregarListas();
  if (abaAtual === 'indicadores') carregarIndicadores();
});


// =========================================================
// 11. ARRASTAR E SOLTAR NA MATRIZ
// =========================================================
// A biblioteca Sortable cuida do gesto (dedo ou mouse). Nós só tratamos
// o "soltou": descobrimos qual tarefa foi e para qual quadrante, e gravamos.
// As 5 listas (0 = sem quadrante, 1 a 4) estão no mesmo "grupo",
// por isso dá para arrastar de uma para outra.

document.querySelectorAll('.lista-arrastavel').forEach((lista) => {
  Sortable.create(lista, {
    group: 'matriz',
    animation: 150,
    delay: 250,                // no celular, precisa SEGURAR um instante antes de arrastar,
    delayOnTouchOnly: true,    // senão rolar a tela viraria arrastar sem querer
    filter: '.vazio',          // o texto "Vazio" não é arrastável
    ghostClass: 'arrastando-fantasma',
    dragClass: 'arrastando-item',
    onEnd: aoSoltar,
  });
});

async function aoSoltar(evento) {
  const de = Number(evento.from.dataset.q);
  const para = Number(evento.to.dataset.q);
  if (de === para) return;   // só mudou a ordem dentro do mesmo quadrante

  const id = Number(evento.item.dataset.id);
  const tarefa = tarefasCarregadas.find((t) => t.id === id);
  if (!tarefa) return;

  const novoQuadrante = para === 0 ? null : para;
  const { error } = await db.from('tarefas')
    .update({ quadrante: novoQuadrante, area_id: tarefa.area_id ?? areaAtual })
    .eq('id', id);

  if (error) {
    console.error('Erro ao mover tarefa:', error);
    alert('Não consegui mover a tarefa: ' + error.message);
  }
  await recarregarListas();

  // Veio de "Sem quadrante" para um quadrante: abre a ficha para completar
  if (!error && de === 0 && para !== 0) {
    abrirFicha({ ...tarefa, quadrante: novoQuadrante, area_id: tarefa.area_id ?? areaAtual });
  }
}


// =========================================================
// 12. TELA DE CATEGORIAS
// =========================================================
// Aqui listamos TODAS as categorias da área (inclusive as desativadas),
// diferente de carregarCategorias(), que só traz as ativas para as listas.

async function carregarTelaCategorias() {
  const { data, error } = await db
    .from('categorias')
    .select('id, nome, cor, ativa')
    .eq('area_id', areaAtual)
    .order('ativa', { ascending: false })
    .order('nome');
  if (error) {
    el('msg-categoria').textContent = 'Erro ao carregar: ' + error.message;
    return console.error('Erro ao carregar categorias:', error);
  }

  const lista = el('lista-categorias');
  lista.innerHTML = '';
  if (data.length === 0) {
    lista.innerHTML = '<li class="vazio">Nenhuma categoria nesta área ainda.</li>';
  }

  data.forEach((cat) => {
    const item = document.createElement('li');
    item.classList.toggle('inativa', !cat.ativa);

    const cor = document.createElement('input');
    cor.type = 'color';
    cor.value = cat.cor || '#7a8291';
    cor.setAttribute('aria-label', 'Cor de ' + cat.nome);
    cor.addEventListener('change', () => salvarCategoria(cat.id, { cor: cor.value }));

    const nome = document.createElement('input');
    nome.type = 'text';
    nome.value = cat.nome;
    // "change" dispara quando você sai do campo depois de editar
    nome.addEventListener('change', () => {
      const novo = nome.value.trim();
      if (!novo) { nome.value = cat.nome; return; }
      salvarCategoria(cat.id, { nome: novo });
    });

    const chave = document.createElement('label');
    chave.className = 'ativa-chave';
    const ativa = document.createElement('input');
    ativa.type = 'checkbox';
    ativa.checked = cat.ativa;
    ativa.addEventListener('change', () => {
      item.classList.toggle('inativa', !ativa.checked);
      salvarCategoria(cat.id, { ativa: ativa.checked });
    });
    chave.append(ativa, 'ativa');

    item.append(cor, nome, chave);
    lista.appendChild(item);
  });
}

async function salvarCategoria(id, campos) {
  el('msg-categoria').textContent = '';
  const { error } = await db.from('categorias').update(campos).eq('id', id);
  if (error) {
    // Nome repetido na mesma área esbarra na regra "unique (area_id, nome)" do banco
    el('msg-categoria').textContent = error.code === '23505'
      ? 'Já existe uma categoria com esse nome nesta área.'
      : 'Erro ao salvar: ' + error.message;
    console.error('Erro ao salvar categoria:', error);
    await carregarTelaCategorias();
    return;
  }
  await carregarCategorias();   // atualiza as cores e nomes nas listas
  await recarregarListas();
}

el('form-categoria').addEventListener('submit', async (evento) => {
  evento.preventDefault();
  const nome = el('cat-nome').value.trim();
  if (!nome) return;

  el('msg-categoria').textContent = '';
  const { error } = await db.from('categorias')
    .insert({ nome, cor: el('cat-cor').value, area_id: areaAtual });
  if (error) {
    el('msg-categoria').textContent = error.code === '23505'
      ? 'Já existe uma categoria com esse nome nesta área.'
      : 'Erro ao criar: ' + error.message;
    return console.error('Erro ao criar categoria:', error);
  }
  el('cat-nome').value = '';
  await carregarCategorias();
  await carregarTelaCategorias();
});


// =========================================================
// 13. NOTIFICAÇÕES
// =========================================================
// Como funciona:
//  1. O celular gera uma "inscrição" (um endereço único do aparelho no
//     serviço de notificações do Google) assinada com a nossa chave pública.
//  2. Guardamos essa inscrição na tabela push_inscricoes.
//  3. A função enviar-lembretes, no servidor, usa a inscrição para
//     mandar o aviso; o sw.js recebe e mostra na tela.

// Chave PÚBLICA de notificação (a privada fica só no servidor)
const VAPID_PUBLICA =
  'BKi9363Kb2uFBUmFV4DbvNQuGKSYdA2vhV4e1mPzVfDDCsoM28-kRUC5d2YN7Ed8SaY_NTnV2JWxBLI5T7vIHJ8';

// O navegador quer a chave em bytes, não em texto: esta função converte
function base64ParaBytes(texto) {
  const padding = '='.repeat((4 - (texto.length % 4)) % 4);
  const base64 = (texto + padding).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

const suportaNotificacao = () =>
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

// Guarda (ou atualiza) a inscrição deste aparelho no banco
async function salvarInscricao(inscricao) {
  const json = inscricao.toJSON();
  const { error } = await db.from('push_inscricoes').upsert(
    { endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth },
    { onConflict: 'endpoint' },   // mesmo aparelho de novo = atualiza, não duplica
  );
  if (error) console.error('Erro ao salvar inscrição:', error);
  return !error;
}

async function ativarNotificacoes() {
  if (!suportaNotificacao()) {
    alert('Este navegador não suporta notificações. No Android, use o app instalado pelo Chrome.');
    return;
  }

  const permissao = await Notification.requestPermission();
  if (permissao !== 'granted') {
    alert('As notificações foram bloqueadas. Para liberar: configurações do Android → Apps → ' +
          'Minha Eisenhower (ou Chrome) → Notificações.');
    return atualizarEstadoNotificacoes();
  }

  try {
    const registro = await navigator.serviceWorker.ready;
    let inscricao = await registro.pushManager.getSubscription();
    if (!inscricao) {
      inscricao = await registro.pushManager.subscribe({
        userVisibleOnly: true,                       // toda mensagem vira notificação visível
        applicationServerKey: base64ParaBytes(VAPID_PUBLICA),
      });
    }
    await salvarInscricao(inscricao);
  } catch (erro) {
    console.error('Erro ao ativar notificações:', erro);
    alert('Não consegui ativar: ' + erro.message);
  }
  await atualizarEstadoNotificacoes();
}

// Mostra no menu se está ativado. Se já está, renova a inscrição em silêncio
// (o Google às vezes troca o endereço do aparelho)
async function atualizarEstadoNotificacoes() {
  const ligadas = suportaNotificacao() && Notification.permission === 'granted';
  el('texto-notificacoes').textContent = ligadas ? 'Notificações ativadas ✓' : 'Ativar notificações';
  el('btn-notificacoes').classList.toggle('ligadas', ligadas);
  el('btn-testar-notificacao').hidden = !ligadas;

  if (ligadas && navigator.onLine) {
    try {
      const registro = await navigator.serviceWorker.ready;
      const inscricao = await registro.pushManager.getSubscription();
      if (inscricao) await salvarInscricao(inscricao);
    } catch (e) { /* sem service worker ainda (ex.: aberto pelo arquivo) */ }
  }
}

el('btn-notificacoes').addEventListener('click', () => {
  if (suportaNotificacao() && Notification.permission === 'granted') {
    alert('As notificações já estão ativas neste aparelho. Coloque um lembrete na ficha de uma tarefa.');
  } else {
    ativarNotificacoes();
  }
});

// Teste local: mostra uma notificação sem passar pelo servidor.
// Se esta aparecer, o aparelho está pronto para receber.
el('btn-testar-notificacao').addEventListener('click', async () => {
  const registro = await navigator.serviceWorker.ready;
  registro.showNotification('Minha Eisenhower', {
    body: 'Teste ok! É assim que seus lembretes vão aparecer.',
    icon: 'icone-192.png',
    badge: 'icone-192.png',
  });
  fecharMenu();
});


// =========================================================
// 13b. INSTALAR O APP
// =========================================================
// Quando o site cumpre as regras de app (manifesto, ícones, service worker),
// o Chrome dispara o evento "beforeinstallprompt". Guardamos esse evento
// e só chamamos .prompt() quando você toca em "Instalar app".

let pedidoDeInstalacao = null;

// Aberto como app instalado (tela cheia) = não precisa do botão
const estaInstalado = () =>
  window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function mostrarBotaoInstalar() {
  el('grupo-instalar').hidden = estaInstalado();
}

window.addEventListener('beforeinstallprompt', (evento) => {
  evento.preventDefault();            // não deixa o Chrome mostrar o aviso dele na hora errada
  pedidoDeInstalacao = evento;
  mostrarBotaoInstalar();
});

el('btn-instalar').addEventListener('click', async () => {
  fecharMenu();
  if (pedidoDeInstalacao) {
    pedidoDeInstalacao.prompt();      // abre a janela "Instalar app?" do Chrome
    const { outcome } = await pedidoDeInstalacao.userChoice;
    if (outcome === 'accepted') pedidoDeInstalacao = null;
    return;
  }
  // O Chrome ainda não liberou o evento (às vezes demora alguns segundos
  // na primeira visita): mostra o caminho manual
  alert('Para instalar: toque nos três pontinhos ⋮ do Chrome, no canto de cima, ' +
        'e escolha "Instalar app" (ou "Adicionar à tela inicial").');
});

// Instalou: some com o botão
window.addEventListener('appinstalled', () => {
  pedidoDeInstalacao = null;
  el('grupo-instalar').hidden = true;
});

mostrarBotaoInstalar();


// =========================================================
// 13c. BOTÃO ATUALIZAR (⟳)
// =========================================================
// Mantenha igual à VERSAO do sw.js: aparece no rodapé do menu
const VERSAO_APP = 'v10';
el('versao-app').textContent = 'versão ' + VERSAO_APP;

// Quando um service worker NOVO assume o controle, recarrega a página uma vez,
// para a tela passar a usar os arquivos novos.
// (Na primeiríssima visita não havia controlador: aí não recarrega.)
const tinhaControlador = !!navigator.serviceWorker?.controller;
let recarregando = false;
navigator.serviceWorker?.addEventListener('controllerchange', () => {
  if (!tinhaControlador || recarregando) return;
  recarregando = true;
  location.reload();
});

el('btn-atualizar').addEventListener('click', async () => {
  const botao = el('btn-atualizar');
  botao.classList.add('girando');
  botao.disabled = true;
  try {
    // 1. Pergunta ao GitHub se o sw.js mudou. Se mudou, o novo se instala
    //    e o "controllerchange" acima recarrega a página com a versão nova.
    const registro = await navigator.serviceWorker?.getRegistration();
    await registro?.update();

    // 2. Enquanto isso, atualiza os dados do banco
    await enviarFilaOffline();
    await carregarCronometroAtivo();
    await recarregarListas();
    if (abaAtual === 'indicadores') await carregarIndicadores();
    if (abaAtual === 'categorias') await carregarTelaCategorias();
  } catch (erro) {
    console.error('Erro ao atualizar:', erro);
  } finally {
    setTimeout(() => {   // deixa girar um instante, para dar a sensação de que atualizou
      botao.classList.remove('girando');
      botao.disabled = false;
    }, 600);
  }
});


// =========================================================
// 14. COMEÇA AQUI
// =========================================================
iniciar();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js')
    .catch((erro) => console.error('Erro ao registrar o service worker:', erro));
}
