import './styles.css';

import { inv, listen, PREFIX } from './rpc.js';
import { $, el, stripAnsi, clear, setEmpty, scrollBottom, updateScrollBtn, uiSettings, caps, cards, pendingPromptRows } from './shared.js';
import { setMarkdown, mdRow, copyText, extActivity } from './markdown.js';
import { card, thinkBlock, applyToolResult, setDiffRenderer } from './tool-cards.js';
import { appendHighlighted, langFor } from './highlight.js';
import { diffView, setDiffView, splitHunk } from './diffview.js';
import { initTerminal, reconcileTerminal } from './terminal.js';
import { validateTheme, applyTheme, resetTheme, themeFromDom, bootTheme } from './theme.js';

/* Tema por JSON: aplicado antes de qualquer render para o padrão não piscar na tela. */
bootTheme();

/* Zoom da UI: o webview não tem zoom de página, então escala o `body`.
   0.6–2.0, passo 0.1, persistido no localStorage. Devolve o valor aplicado. */
let zoom = 1;
try { zoom = +localStorage.getItem('zoom') || 1; } catch { /* sem storage */ }
export function setZoom(z) {
  zoom = Math.min(2, Math.max(0.6, Math.round(z * 100) / 100));
  document.body.style.zoom = zoom;
  try { localStorage.setItem('zoom', zoom); } catch { /* sem storage */ }
  return zoom;
}
setZoom(zoom);
$('zoomin').onclick = () => setZoom(zoom + 0.1);
$('zoomout').onclick = () => setZoom(zoom - 0.1);

/* Esc interrompe o turno da aba atual. Registrado no topo de propósito: os outros
   handlers de Esc (paleta, model-pop, imagens) fecham overlays sem `preventDefault`
   e rodariam depois — assim a checagem enxerga o overlay ainda aberto e um Esc de
   "fechar" nunca aborta turno. Vale com o foco no composer/busca (é de lá que o
   usuário vê o turno rodando); só o terminal embutido consome o Esc (ex.: vim). */
/* Decisão pura do atalho Esc: aborta quando o turno trabalha, sem overlay aberto
   e sem foco no terminal embutido (o foco no composer/busca não bloqueia). */
export function shouldAbortOnEsc({ overlayOpen, inTerminal, working }) {
  return !overlayOpen && !inTerminal && !!working;
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  const overlayOpen = !!document.querySelector('.overlay:not(.hidden),.confirm-bar:not(.hidden),.settings-pop:not(.hidden),.palette:not(.hidden),.model-pop:not(.hidden),.img-view:not(.hidden)');
  const ae = document.activeElement;
  const inTerminal = !!(ae && ae.closest && ae.closest('#termdock'));
  const t = tabs.find(x => current && x.key === current.key);
  if (shouldAbortOnEsc({ overlayOpen, inTerminal, working: !!(t && t.working) })) abortTurn();
});

let current = null;
let seq = 0;
let stream = null;            // { node, text }
let pendingRender = 0;
let homeDir = null;
let sessionState = null;
let compactBusy = false;      // compactação manual em voo (evita duplo clique)
let compactReserve = null;    // reserva escolhida para o modelo atual (null = padrão do pi)
let allModels = [];
let modelsByProvider = new Map();
let levelList = [];
let debugEnabled = false;
let tabs = [];
/* Título canônico por sessão (lido do .jsonl por loadSessions) — a aba mostra isso,
   não a data/hora do id. */
let sessionTitles = new Map();
/* Imagens coladas no composer, aguardando envio (base64 + mimeType). */
let pendingImages = [];
let activeTab = null;
/* Geração da view: cada troca de sessão incrementa. Leitura assíncrona que resolve
   depois da troca (histórico, "carregar anteriores", children) não pode mais pintar
   no #log nem reabrir a barra de paginação na sessão nova (bug 2026-11-15). */
let viewSeq = 0;

let statsNoteRequested = false;

function setEmptyState(on, kind) {
  const el0 = $('emptystate');
  if (!el0) return;
  el0.classList.toggle('hidden', !on);
  const sub = el0.querySelector('.es-sub');
  if (sub) {
    if (kind === 'newsession') {
      sub.textContent = 'Sessão nova — escreva abaixo para começar.';
    } else if (kind === 'nosession') {
      clear(sub);
      sub.append('Selecione uma sessão na barra à esquerda');
      sub.append(el('br'));
      sub.append('ou crie uma nova com ');
      const b = el('b', null, '+ Nova');
      sub.append(b, ' / ');
      sub.append(el('b', null, '+'));
      sub.append(' no projeto.');
    }
  }
}

/** Mostra/esconde o indicador de atividade do turno. */
function setTyping(on, label) {
  const box = $('typing');
  if (!box) return;
  box.classList.toggle('hidden', !on);
  if (label) $('typinglabel').textContent = label;
}

/** Botão de parar do composer: aparece só com turno rodando.
    O `#send` fica SEMPRE habilitado de propósito — com turno rodando ele enfileira
    (`streamingBehavior: steer`) e a fila é recurso pedido (`#unque` devolve as
    mensagens ao composer); só o `title` muda para dizer que é enfileiramento. */
export function syncStopButton(working) {
  const stop = $('stopbtn');
  if (stop) stop.classList.toggle('hidden', !working);
  const send = $('send');
  if (send) send.title = working ? 'Enfileirar mensagem (turno rodando)' : 'Enviar (Enter)';
  return !!working;
}

/**
 * Turno em andamento é estado da ABA, não da janela: sem isso o "enviado…/pensando…"
 * da aba anterior continuava na tela depois de trocar (inclusive em sessão nova vazia).
 */
function setTurn(sessionId, working, phase) {
  const t = tabs.find(x => x.key === sessionId);
  if (t) {
    const changed = !!t.working !== !!working;
    t.working = working;
    t.phase = working ? (phase || t.phase || 'pensando…') : '';
    // Turno que começa zera o silêncio: o vigia conta a partir daqui, não do último
    // evento antigo da sessão (senão sondaria o turno recém-enviado).
    if (changed && working) t.lastEventAt = Date.now();
    // Só redesenha na transição: text_delta chega a cada token.
    if (changed) renderTabs();
  }
  if (current && current.key === sessionId) {
    setTyping(working, (t && t.phase) || phase || 'pensando…');
    // Mesmo caminho do indicador: o botão de parar segue o turno da aba em foco.
    syncStopButton(!!working);
    if (working) { setStatus('trabalhando'); setState('busy'); }
  }
}

/* =============== vigia do turno fantasma =============== */
/* `agent_settled` é o único sinal de fim de turno. Quando ele se perde (processo morto
   sem exit, filho trocado, sessão aberta em duas instâncias) a aba fica "trabalhando"
   para sempre: spinner girando e Esc sem efeito. O vigia pergunta o estado real ao pi
   e destrava a aba quando ele confirma que já não há turno rodando. */
const TURN_SILENCE_MS = 45000; // silêncio por aba que dispara a sonda
const TURN_PROBE_MS = 30000;   // intervalo mínimo entre sondas da mesma aba
const PROBE_PREFIX = 'probe:';
/* Última sonda por aba (transiente: não vai para o saveTabs). */
const lastProbeAt = {};

/** Predicado puro do vigia: só sonda aba trabalhando, silenciosa e fora do intervalo. */
export function shouldProbeTurn({ working, lastEventAt, now, silenceMs, lastProbeAt: probeAt, probeIntervalMs }) {
  if (!working) return false;
  if (now - (lastEventAt || 0) <= silenceMs) return false;
  return now - (probeAt || 0) >= probeIntervalMs;
}

/** Turno fantasma: zera o indicador, descarta o parcial e realinha com o disco. */
function settleGhostTurn(key, why) {
  const t = tabs.find(x => x.key === key);
  setTurn(key, false);
  delete lastProbeAt[key];
  if (t) { t.streamText = ''; t.thinkText = ''; t.queue = []; saveTabs(); }
  renderTabs();
  if (!current || current.key !== key) return;
  stream = null;
  setTyping(false);
  setStatus(why);
  setState('ready');
  // O parcial do turno morto nunca foi para o disco: repinta o que o pi persistiu.
  if (t && t.file) loadHistoryFromDisk(t.file);
  else sendCommand({ type: 'get_messages' });
  loadGit(); loadEdits();
  note(why);
}

/** Resposta da sonda: só destrava quando o pi confirma que não há turno rodando. */
function reconcileTurn(key, rec) {
  const t = tabs.find(x => x.key === key);
  // Turno já encerrou por outro caminho (agent_settled/exit) ou a aba sumiu.
  if (!t || !t.working) return;
  const d = (rec && rec.data) || {};
  // Ainda rodando: nada a fazer. A própria linha da sonda já renovou o silêncio.
  if (rec && rec.success && (d.isStreaming || d.isCompacting || d.pendingMessageCount)) return;
  settleGhostTurn(key, rec && rec.success
    ? 'turno encerrado sem aviso do pi — indicador destravado'
    : 'o pi não respondeu ao estado do turno — indicador destravado');
}

function turnWatchdog() {
  const now = Date.now();
  for (const t of tabs) {
    // Aba sem processo vivo não tem turno para reconciliar (e some de `tabs` ao fechar).
    if (!t.connected) continue;
    const probe = shouldProbeTurn({
      working: !!t.working, lastEventAt: t.lastEventAt, now,
      silenceMs: TURN_SILENCE_MS, lastProbeAt: lastProbeAt[t.key], probeIntervalMs: TURN_PROBE_MS,
    });
    if (!probe) continue;
    lastProbeAt[t.key] = now;
    // `probe:<key>` não colide com id de RPC normal e identifica a aba na resposta.
    inv('rpc_command', { sessionId: t.key, payload: JSON.stringify({ id: PROBE_PREFIX + t.key, type: 'get_state' }) })
      // Sonda recusada = slot do processo morreu; também não há turno rodando.
      .catch(() => reconcileTurn(t.key, null));
  }
}
setInterval(turnWatchdog, 5000);

/** Último aviso por sessão: turnos curtos em sequência não podem empilhar som/popup. */
const lastNotifyAt = {};

/** Toque curto (WebAudio): o turno de outra aba terminou. */
function beep() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    const t0 = ctx.currentTime;
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.2, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.35);
    o.start(t0); o.stop(t0 + 0.4);
    o.onended = () => ctx.close().catch(() => {});
  } catch { /* sem áudio */ }
}

/**
 * Turno de aba em 2º plano terminou: avisa (popup + som) uma vez por janela.
 * Só dispara quando a sessão que assentou NÃO é a atual E a aba estava trabalhando.
 */
function maybeNotifyDone(sessionId) {
  if (!uiSettings.notifyDesktop && !uiSettings.notifySound) return;
  if (current && sessionId === current.key) return;
  const t = tabs.find(x => x.key === sessionId);
  if (!t || !t.working) return;
  const now = Date.now();
  if (now - (lastNotifyAt[sessionId] || 0) < 4000) return;
  lastNotifyAt[sessionId] = now;
  if (uiSettings.notifySound) beep();
  if (uiSettings.notifyDesktop && window.Notification && Notification.permission === 'granted') {
    try { new Notification('sightdeck: turno pronto', { body: t.label || sessionId }); } catch { /* negado */ }
  }
}

/** Reaplica o indicador do turno da aba que acabou de ficar ativa. */
function applyTurnUi() {
  const t = current ? tabs.find(x => x.key === current.key) : null;
  const on = !!(t && t.working);
  setTyping(on, (t && t.phase) || 'pensando…');
  syncStopButton(on);
  renderHealthChip();
  if (on) { setStatus('trabalhando'); setState('busy'); }
}
function setStatus(t) { $('status').textContent = stripAnsi(t); }

function setState(kind) {
  const dot = $('statedot');
  if (dot) dot.className = 'dot ' + kind;
}

function debugNote(msg) {
  if (!debugEnabled) return;
  inv('debug_note', { msg }).catch(() => {});
}

function showFatal(msg) {
  let bar = document.getElementById('fatal');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'fatal';
    bar.className = 'fatal';
    document.body.appendChild(bar);
  }
  bar.textContent = String(msg);
}

window.addEventListener('error', (e) => showFatal('JS: ' + (e.message || 'erro')));
window.addEventListener('unhandledrejection', (e) =>
  showFatal('promise: ' + ((e.reason && e.reason.message) || e.reason)));

function prettyId(stem) {
  const m = stem.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-\d{2}-\d{3}Z[_-]?(.*)$/);
  if (!m) return stem;
  const [, , mo, d, h, mi, rest] = m;
  return `${d}/${mo} ${h}:${mi}${rest ? ' · ' + rest.slice(0, 14) : ''}`;
}

/** Nome do projeto da aba, mesma convenção da sidebar (`cwd` sem o último segmento). */
function projectName(cwd) {
  if (!cwd) return '';
  if (homeDir && cwd === homeDir) return '~';
  const name = String(cwd).replace(/\/+$/, '').split('/').pop();
  return name || cwd;
}

/* =============== sidebar =============== */
/* =============== árvore de projetos =============== */
let collapsedProjects = new Set();
let hiddenProjects = new Set();
/* Projetos com a lista completa liberada ("carregar mais"). */
let expandedProjects = new Set();
const SESS_PAGE = 8;

function loadTreeState() {
  try {
    collapsedProjects = new Set(JSON.parse(localStorage.getItem('collapsed-projects') || '[]'));
    hiddenProjects = new Set(JSON.parse(localStorage.getItem('hidden-projects') || '[]'));
    expandedProjects = new Set(JSON.parse(localStorage.getItem('expanded-projects') || '[]'));
  } catch { /* defaults */ }
}

function saveTreeState() {
  try {
    localStorage.setItem('collapsed-projects', JSON.stringify([...collapsedProjects]));
    localStorage.setItem('hidden-projects', JSON.stringify([...hiddenProjects]));
    localStorage.setItem('expanded-projects', JSON.stringify([...expandedProjects]));
  } catch { /* sem storage */ }
}

/* Excluir sessão = mover para <projeto>/.sightdeck-trash/ (nunca apaga). */
function askDeleteSession(s) {
  confirmRun('mover para lixeira: ' + s.file, async () => {
    if (current && current.key === s.id) { try { await closeTab(s.id); } catch { /* já fechada */ } }
    try {
      const out = await inv('delete_session', { file: s.file });
      setStatus(String(out));
      await loadSessions();
    } catch (e) {
      setStatus('erro: ' + e);
    }
  });
}

async function addProject() {
  let path = '';
  // O seletor nativo pode abrir atrás de outra janela: avisa para procurá-lo.
  setStatus('seletor de pasta aberto — procure a janela de arquivos…');
  try {
    path = String(await inv('pick_directory')).trim();
  } catch (e) {
    if (!String(e).includes('cancelado')) setStatus(String(e));
    else setStatus('pronto');
    return;
  }
  if (!path) return;

  // Projeto escolhido: abre já expandido quando a lista recarregar.
  collapsedProjects.delete(path);
  hiddenProjects.delete(path);
  saveTreeState();

  await newSessionIn(path);
  setTimeout(() => loadSessions(), 1200);
}

function newSessionIn(cwd) {
  const key = 'ui-' + Date.now().toString(36);
  return start(cwd, key, key, '--session-id', null);
}

async function loadSessions() {
  try {
    const groups = JSON.parse(await inv('list_sessions'));
    // Projeto aberto agora (ex.: + Pasta) ainda não tem .jsonl — o pi só grava na
    // primeira mensagem. Sem isto o projeto não entra na lista e parece que falhou.
    for (const t of tabs) {
      if (!t.cwd || groups.some(g => g.path === t.cwd)) continue;
      groups.push({ path: t.cwd, name: t.cwd.split('/').pop() || t.cwd, sessions: [] });
    }
    const side = $('sessions');
    clear(side);

    const visible = groups.filter(g => !hiddenProjects.has(g.path) || uiSettings.showHidden);
    if (!visible.length) { setEmpty(side, 'nenhuma sessão em ~/.pi/agent/sessions'); return; }

    // Títulos ficam em cache: a aba aberta mostra o mesmo nome da lista.
    let titlesChanged = false;
    for (const g of visible) {
      for (const s of g.sessions) {
        if (s.title) sessionTitles.set(s.id, s.title);
        const tab = tabs.find(t => t.key === s.id);
        if (tab && s.title && tab.label !== s.title) { tab.label = s.title; titlesChanged = true; }
      }
    }
    if (titlesChanged) renderTabs();

    const treeInit = localStorage.getItem('collapsed-initialized');
    if (treeInit === null) {
      for (const g of visible) collapsedProjects.add(g.path);
      saveTreeState();
      try { localStorage.setItem('collapsed-initialized', '1'); } catch { /* sem storage */ }
    }

    for (const g of visible) {
      const isCollapsed = collapsedProjects.has(g.path);
      const box = el('div', 'group' + (isCollapsed ? ' collapsed' : ''));

      const head = el('div', 'group-head');
      head.appendChild(el('span', 'caret', isCollapsed ? '▸' : '▾'));
      const isHome = homeDir && g.path === homeDir;
      const name = el('span', 'proj-name', isHome ? 'sem projeto' : (g.name || g.path));
      name.title = g.path;
      head.appendChild(name);
      if (g.sessions.length) head.appendChild(el('span', 'proj-count', String(g.sessions.length)));

      const plus = el('button', 'tiny plus', '+');
      plus.title = 'Nova sessão neste projeto (' + g.path + ')';
      plus.onclick = (e) => { e.stopPropagation(); newSessionIn(g.path); };
      head.appendChild(plus);

      const hide = el('button', 'tiny', hiddenProjects.has(g.path) ? '↺' : '⊘');
      hide.title = hiddenProjects.has(g.path) ? 'Mostrar projeto' : 'Ocultar projeto (não apaga nada)';
      hide.onclick = (e) => {
        e.stopPropagation();
        if (hiddenProjects.has(g.path)) hiddenProjects.delete(g.path);
        else hiddenProjects.add(g.path);
        saveTreeState();
        loadSessions();
      };
      head.appendChild(hide);

      head.onclick = () => {
        if (collapsedProjects.has(g.path)) collapsedProjects.delete(g.path);
        else collapsedProjects.add(g.path);
        saveTreeState();
        loadSessions();
      };
      box.appendChild(head);

      const list = el('div', 'sess-list');
      const shown = expandedProjects.has(g.path) ? g.sessions : g.sessions.slice(0, SESS_PAGE);
      for (const s of shown) {
        const row = el('div', 'sess');
        row.dataset.key = s.id;
        row.title = (s.title || s.id) + '\n' + s.id;

        const title = el('div', 'sess-title', s.title || 'sem título');
        const meta = el('div', 'sess-meta');
        meta.appendChild(el('span', null, prettyId(s.id)));
        if (s.children > 0) {
          const b = el('span', 'badge', String(s.children));
          b.title = 'subagent runs desta sessão';
          meta.appendChild(b);
        }

        const del = el('button', 'tiny', '×');
        del.title = 'Mover esta sessão para a lixeira';
        del.onclick = (e) => { e.stopPropagation(); askDeleteSession(s); };
        meta.appendChild(del);

        row.append(title, meta);
        row.onclick = () => openSession(s.cwd || g.path, s);
        list.appendChild(row);
      }
      // Pasta com histórico longo: limita a leitura e libera sob demanda.
      const hiddenCount = g.sessions.length - shown.length;
      if (hiddenCount > 0) {
        const more = el('button', 'sess-more', 'carregar mais (' + hiddenCount + ')');
        more.onclick = (e) => { e.stopPropagation(); expandedProjects.add(g.path); saveTreeState(); loadSessions(); };
        list.appendChild(more);
      }
      box.appendChild(list);
      side.appendChild(box);
    }
  } catch (e) {
    setEmpty($('sessions'), String(e), 'empty err');
  }
}

/* =============== busca global nas sessões =============== */
let searchTimer = 0;
let searchOffset = 0;
const SEARCH_PAGE = 20;

function searchActive() {
  const q = ($('sesssearch') && $('sesssearch').value || '').trim();
  const t = ($('toolfilter') && $('toolfilter').value || '').trim();
  const e = !!($('erronly') && $('erronly').checked);
  return q !== '' || t !== '' || e;
}

function setSearchMeta(t) {
  const m = $('searchmeta');
  clear(m);
  m.appendChild(el('span', null, t));
}

function scheduleSearch() {
  // Filtros aparecem ao focar/digitar; sem critério a árvore normal volta.
  const on = searchActive();
  const focused = document.activeElement === $('sesssearch');
  $('searchfilters').classList.toggle('hidden', !on && !focused);
  $('searchresults').classList.toggle('hidden', !on);
  $('searchmeta').classList.toggle('hidden', !on);
  if (!on) { loadSessions(); return; }
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(false), 300);
}

async function runSearch(append) {
  const query = $('sesssearch').value || '';
  const tool = $('toolfilter').value || '';
  const errorsOnly = !!$('erronly').checked;
  if (!append) searchOffset = 0;
  setSearchMeta('buscando…');
  try {
    const raw = await inv('search_sessions', { query, tool, errorsOnly, limit: SEARCH_PAGE, offset: searchOffset });
    const res = JSON.parse(raw);
    const items = (res && res.results) || [];
    if (!append) clear($('searchresults'));
    $('searchresults').querySelectorAll('.sess-more').forEach(n => n.remove());
    for (const r of items) {
      const row = el('div', 'sess');
      row.dataset.key = r.id;
      row.title = (r.title || r.id) + '\n' + r.file;
      row.appendChild(el('div', 'sess-title', r.title || 'sem título'));
      if (r.snippet) row.appendChild(el('div', 'snippet', r.snippet));
      const meta = el('div', 'sess-meta');
      meta.appendChild(el('span', null, prettyId(r.id) + ' · ' + r.matches + ' trecho(s)'));
      if (r.tools && r.tools.length) meta.appendChild(el('span', 'badge', r.tools.slice(0, 3).join(',')));
      if (r.hasError) meta.appendChild(el('span', 'badge', 'erro'));
      row.append(meta);
      row.onclick = () => openSession(r.cwd, r);
      $('searchresults').appendChild(row);
    }
    searchOffset += items.length;
    const total = (res && res.total) || 0;
    setSearchMeta(total + ' sessão(ões)' + (res && res.truncated ? ' · teto de leitura atingido' : '') + (searchOffset < total ? ' · mostrando ' + searchOffset : ''));
    // Paginação: o botão some quando tudo já está na tela.
    if (searchOffset < total) {
      const more = el('button', 'sess-more', 'mostrar mais (' + (total - searchOffset) + ')');
      more.onclick = (e) => { e.stopPropagation(); runSearch(true); };
      $('searchresults').appendChild(more);
    }
    if (!items.length && !append) setEmpty($('searchresults'), 'nada encontrado', 'empty');
  } catch (e) {
    setSearchMeta(String(e));
  }
}

function clearSearch() {
  $('sesssearch').value = '';
  $('toolfilter').value = '';
  $('erronly').checked = false;
  scheduleSearch();
}

/* =============== sessão =============== */
async function start(cwd, key, refValue, refFlag, childrenDir) {
  // Nova sessão / troca: zera paginação e esconde a barra herdada da sessão anterior.
  resetPaged();

  // Click na sessão já aberta: recarrega o histórico em vez de ignorar.
  if (current && current.key === key) {
    if (refFlag !== '--session-id' && refValue) await loadHistoryFromDisk(refValue);
    if (await ensureRpc()) sendCommand({ type: 'get_messages' });
    return;
  }
  // Sim, encerra a sessão anterior — mas nunca no meio de um turno e sempre limpando
  // o estado (senão a aba fica "connected" apontando para um processo morto).
  if (current) {
    const prev = tabs.find(x => x.key === current.key);
    if (!(prev && prev.working)) {
      try { await inv('stop_session', { sessionId: current.key }); } catch { /* já parado */ }
      stopLive(current.key);
    }
  }
  stashDraft();
  viewSeq++;
  current = { key, cwd, childrenDir, refValue, refFlag: refFlag || '--session' };
  reconcileTerminal();  // terminal aberto herda a pasta da sessão
  cards.clear();
  pendingPromptRows.clear();
  lastSnap = null;
  lastDiskList = null;
  resetFiles();
  stream = null;
  sessionState = null;
  // Sessão nova não tem cache: zera a lista para não mostrar o thinking do modelo anterior.
  levelList = [];
  fillLevels([]);
  allModels = [];
  clear($('log'));
  setTyping(false);
  restoreDraft(tabs.find(t => t.key === key) || null);
  // `+`, `+ Nova` e `+ Pasta` abrem sessão sem histórico; a overlay de estado
  // vazio é opaca e cobre o #log, então sem isto a sessão nova parece não ter aberto.
  setEmptyState(false);
  setEmpty($('subs'), noSubsMessage());
  setStatus('iniciando… ' + prettyId(key));

  // Histórico vem do disco primeiro: não depende do RPC responder.
  if (refFlag !== '--session-id' && refValue) await loadHistoryFromDisk(refValue);

  try {
    await inv('start_session', { sessionId: key, cwd, refFlag: refFlag || '--session', refValue });
    // O processo já existe: registra aba e fila do LRU mesmo que a view tenha mudado,
    // senão ele fica órfão (sem ✕, fora da evicção e contando no #procinfo até fechar).
    if (!tabs.find(t => t.key === key)) {
      tabs.push({
        key, cwd, childrenDir, refValue,
        refFlag: refFlag || '--session',
        file: (refFlag || '--session') === '--session' ? refValue : null,
        label: sessionTitles.get(key) || '',
      });
    }
    const tab = tabs.find(t => t.key === key);
    if (tab) tab.connected = true;
    if (!liveOrder.includes(key)) liveOrder.push(key);
    updateProcCount();
    renderTabs();
    // Outra sessão assumiu a view enquanto o processo subia: não rouba a aba de volta.
    if (!current || current.key !== key) return;
    setStatus('conectado · ' + prettyId(key));
    setState('ready');
    current.connected = true;
    activeTab = tab || null;
    if (childrenDir) await loadChildren(childrenDir);
    // Sessão nova só ganha `.jsonl` na 1ª mensagem: o get_state traz `sessionFile`,
    // sem o qual "carregar anteriores" e a aba Arquivos ficam sem caminho no disco.
    sendCommand({ type: 'get_state' });
    loadGit(); loadEdits(); loadPlans();
  } catch (e) {
    // Erro de outra sessão não aparece no transcript da atual.
    if (!current || current.key !== key) return;
    setStatus('erro');
    $('log').appendChild(el('div', 'note', String(e)));
  }
}

/* Abrir sessão = leitura. Nenhum processo `pi` nasce aqui. */
async function openSession(cwd, s) {
  document.querySelectorAll('.sess').forEach(n => n.classList.toggle('active', n.dataset.key === s.id));

  if (current && current.key === s.id) {
    await loadHistoryFromDisk(s.file);
    return;
  }

  stashDraft();
  viewSeq++;
  resetPaged();
  current = {
    key: s.id, cwd,
    childrenDir: s.file.replace(/\.jsonl$/, ''),
    refValue: s.file, refFlag: '--session',
    file: s.file, connected: false,
  };
  cards.clear();
  pendingPromptRows.clear();
  lastSnap = null;
  lastDiskList = null;
  resetFiles();
  stream = null;
  sessionState = null;
  // openSession é só leitura: zera a lista para não herdar o thinking da view anterior.
  levelList = [];
  fillLevels([]);
  clear($('log'));
  setEmptyState(false);
  setTyping(false);
  setStatus('somente leitura');
  setState('off');

  const existing = tabs.find(t => t.key === s.id);
  if (!existing) {
    tabs.push({ key: s.id, cwd, childrenDir: current.childrenDir, refValue: s.file, refFlag: '--session', file: s.file, connected: false, label: s.title || '' });
  } else {
    existing.file = s.file;
    existing.childrenDir = current.childrenDir;
    if (s.title) existing.label = s.title;
  }
  activeTab = tabs.find(t => t.key === s.id) || null;
  if (activeTab && Array.isArray(activeTab.levelList) && activeTab.levelList.length) fillLevels(activeTab.levelList.slice());
  if (activeTab && activeTab.model) { sessionState = { model: activeTab.model, thinkingLevel: activeTab.thinkingLevel || null }; updateModelButton(activeTab.model); }
  restoreDraft(activeTab);
  renderTabs();

  await loadHistoryFromDisk(s.file);

  // Modelo do histórico (sem RPC) + catálogo em cache para o seletor já nascer preenchido.
  if (!modelsByProvider.size) loadCachedModels();
  try {
    const parsed = JSON.parse(String(await inv('session_model', { path: s.file })));
    if (current && current.key !== s.id) return; // trocou de sessão durante a leitura
    if (parsed && parsed.id) {
      const full = allModels.find(m => m.id === parsed.id) || parsed;
      sessionState = { ...(sessionState || {}), model: { ...full, provider: parsed.provider || full.provider } };
      updateModelButton(sessionState.model);
    }
  } catch { /* sessão sem model_change */ }

  await loadChildren(current.childrenDir);

  // Conecta já na abertura: contexto, thinking, modelo e comandos vêm do pi.
  await ensureRpc();
  checkAuth();
  loadGit(); loadEdits(); loadPlans();
}

/* Sobe o processo sob demanda, com teto de sessões vivas. */
const MAX_LIVE = 3;
let liveOrder = [];

async function ensureRpc() {
  if (!current) return false;
  if (current.connected) return true;
  const key = current.key;
  // Chave repetida (reconexão após processo morto) inflava a contagem e disparava
  // evicção de sessão viva com menos de MAX_LIVE processos de verdade.
  liveOrder = [...new Set(liveOrder)];

  // Encolhe até o teto. Vítima errada aqui mata turno em andamento de outra aba
  // (bug: mandar em A, mandar em B, A morre) — só sai aba ociosa e nunca a atual.
  while (liveOrder.length >= MAX_LIVE) {
    const victim = liveOrder.find(k => k !== key && !(tabs.find(t => t.key === k) || {}).working);
    if (!victim) break; // todas ocupadas: prefere exceder o teto a perder trabalho
    liveOrder = liveOrder.filter(k => k !== victim);
    try { await inv('stop_session', { sessionId: victim }); } catch { /* ja parado */ }
    const t = tabs.find(x => x.key === victim);
    if (t) t.connected = false;
    renderTabs();
  }

  const { cwd, refValue, refFlag, file } = current;
  // Processo é desta chave; se a view trocou no meio, o estado da sessão anterior
  // não pode ser anunciado como se fosse a atual.
  const isCurrent = () => !!current && current.key === key;
  try {
    await inv('start_session', {
      sessionId: key, cwd,
      refFlag: refFlag || '--session',
      refValue: refValue || file,
    });
  } catch (e) {
    if (isCurrent()) {
      setStatus('erro ao iniciar pi');
      $('log').appendChild(el('div', 'row note', String(e)));
    }
    return false;
  }

  if (isCurrent()) current.connected = true;
  const tab = tabs.find(t => t.key === key);
  if (tab) tab.connected = true;
  // Dedupe: chave remanescente de processo morto inflava a fila e disparava
  // evicção prematura de sessão viva.
  if (!liveOrder.includes(key)) liveOrder.push(key);
  updateProcCount();
  if (isCurrent()) {
    setStatus('conectado · ' + prettyId(key));
    setState('ready');
    // Processo novo: modelo/contexto/arquivo da sessão vêm daqui.
    sendCommand({ type: 'get_state' });
  }
  return true;
}

async function updateProcCount() {
  try {
    const list = await inv('running_sessions');
    $('procinfo').textContent = list && list.length ? list.length + ' pi' : '';
    $('procinfo').title = Array.isArray(list) ? list.join('\n') : '';
  } catch { /* ignora */ }
}

function stopLive(key) {
  liveOrder = liveOrder.filter(k => k !== key);
  const t = tabs.find(x => x.key === key);
  if (t) t.connected = false;
  setTurn(key, false);
  updateProcCount();
}

/* =============== envio =============== */

/** `send_prompt`, com uma reconexão: o stdin do filho pode ter morrido entre o
 *  connect e este envio (o pi morreu, o Rust liberou o slot). Como o write falhou,
 *  a mensagem não saiu: sobe um processo novo e reenvia uma única vez. */
async function sendPromptWithRetry(key, payload) {
  try {
    await inv('send_prompt', payload);
  } catch (e) {
    if (!/processo do pi encerrou|nao iniciada/.test(String(e))) throw e;
    const t = tabs.find(x => x.key === key);
    if (t) t.connected = false;
    const isCurrent = () => !!current && current.key === key;
    if (isCurrent()) current.connected = false;
    // `ensureRpc` sobe o processo da view atual: só serve se ainda é esta aba.
    if (!isCurrent() || !(await ensureRpc())) throw e;
    await inv('send_prompt', payload);
  }
}

async function send() {
  const typed = $('input').value.trim();
  const hasImages = pendingImages.length > 0;
  if ((!typed && !hasImages) || !current) return;
  // Permissão de notificação se pede no gesto (popup exige interação prévia).
  if (window.Notification && Notification.permission === 'default') {
    try { Promise.resolve(Notification.requestPermission()).catch(() => {}); } catch { /* ignora */ }
  }
  // Imagem sem texto é válida: o pi aceita prompt só com ImageContent.
  const message = typed || 'Segue imagem.';

  // Comando do app (/compact, /login, ...) roda aqui, sem ir para o modelo.
  const app = parseAppCommand(message);
  if (app) {
    $('input').value = '';
    autosizeInput();
    hidePalette();
    $('log').appendChild(el('div', 'row user', '▸ ' + message));
    scrollBottom(true);
    // Comando que fala com o pi precisa do processo vivo (sessão pode estar em leitura).
    if (app.cmd.needsRpc && !(await ensureRpc())) {
      note('não consegui conectar ao pi para rodar /' + app.cmd.name);
      return;
    }
    pushRecent('/' + app.cmd.name + (app.args ? ' ' + app.args : ''));
    app.cmd.run(app.args);
    return;
  }

  if (!(await ensureRpc())) return;

  $('input').value = '';
  autosizeInput();
  // Rascunho da aba zera junto: senão trocar de aba e voltar ressuscita o texto enviado.
  const tab = tabs.find(t => t.key === current.key);
  const wasWorking = !!(tab && tab.working);
  if (tab) { tab.draft = ''; tab.images = []; }
  // O RPC espera pares (base64, mimeType); capturar antes de limpar.
  const sentImages = pendingImages.slice();
  const images = sentImages.map(i => [i.data, i.mime]);
  pendingImages = [];
  renderAttachments();
  const id = 'ui-' + (++seq);
  const key = current.key;
  const urow = el('div', 'row user', '▸ ' + message);
  urow.dataset.text = message;
  // Posição cronológica da linha local: o log é reconstruído do disco a cada render,
  // então a reinserção devolve a linha ao lugar que ela ocupava (insertRowByAt).
  // `data-local` a exclui do `seen` do restore: sem isso ela se auto-invalidaria na
  // restauração seguinte (o próprio texto já estaria no log).
  const at = Date.now();
  urow.dataset.at = String(at);
  urow.dataset.local = '1';
  sentImages.forEach(img => urow.appendChild(thumb(img.dataUrl)));
  $('log').appendChild(urow);
  // A linha fica na aba (não só no Map global): trocar de aba não pode apagá-la
  // antes de o pi persistir a mensagem no .jsonl.
  const entry = { key, text: message, row: urow, state: 'pending', at };
  pendingPromptRows.set(id, entry);
  localRows(tab).push(entry);
  scrollBottom();
  try {
    // O Rust manda `streamingBehavior: "steer"`: com turno rodando o pi enfileira
    // (disposition "queued"), parado é ignorado e o turno começa.
    const payload = { sessionId: key, message, id, images };
    await sendPromptWithRetry(key, payload);
    // Resposta pode chegar depois de trocar de aba: o estado do turno é da chave
    // que enviou, nunca da sessão que está em foco agora.
    const isCurrent = () => !!current && current.key === key;
    if (isCurrent()) {
      setStatus('trabalhando');
      setState('busy');
    }
    // Mensagem enfileirada não reinicia o rótulo do turno que já está rodando.
    setTurn(key, true, wasWorking ? (tab && tab.phase) || 'pensando…' : 'enviado…');
    // Sessão nova ainda sem título: usa a 1ª mensagem (mesma regra do read_title no Rust).
    if (tab && !tab.label) {
      tab.label = message.split('\n')[0].replace(/`/g, '').trim().slice(0, 48);
      renderTabs();
    }
  } catch (e) {
    pendingPromptRows.delete(id);
    // Envio não chegou ao pi: a linha local sai do log (não foi mensagem) e o texto
    // volta ao composer da aba, senão o que foi digitado se perde.
    const list = localRows(tab);
    const li = list.indexOf(entry);
    if (li >= 0) list.splice(li, 1);
    urow.remove();
    if (tab) {
      tab.draft = tab.draft ? message + '\n' + tab.draft : message;
      tab.images = sentImages.concat(Array.isArray(tab.images) ? tab.images : []);
      saveTabs();
    }
    if (current && current.key === key) {
      const box = $('input');
      box.value = box.value.trim() ? message + '\n' + box.value : message;
      autosizeInput();
      pendingImages = sentImages.concat(pendingImages);
      renderAttachments();
      $('log').appendChild(el('div', 'row note', String(e)));
      scrollBottom(true);
    }
  }
}

/* =============== histórico =============== */
function renderMessages(data, ctx, keepNote) {
  const target = (ctx && ctx.target) || $('log');
  // Renderizou no painel principal: não há mais "nenhuma sessão" a mostrar.
  if (target === $('log')) setEmptyState(false);
  const store = (ctx && ctx.store) || cards;
  const messages = (data && data.messages) || [];
  const note = keepNote ? target.querySelector('.row.note') : null;
  clear(target);
  if (note) target.appendChild(note);
  store.clear();
  if (!ctx) stream = null;
  // Ancora de fork por linha: índice/texto das user messages na ordem do transcript.
  let userIdx = -1;
  const userTexts = [];

  for (const m of messages) {
    if (!m || m.role === 'system') continue;
    const blocks = Array.isArray(m.content) ? m.content : null;
    if (m.role === 'user') userIdx++;
    if (m.role === 'user' && userTexts.length <= userIdx) userTexts.push('');

    if (m.role === 'custom') {
      const node = el('div', 'row ext');
      node.appendChild(el('b', null, 'extensão'));
      node.appendChild(el('span', null, ' ' + (m.customType || m.type || 'custom')));
      target.appendChild(node);
      continue;
    }

    if (m.role === 'user') {
      const text = blocks
        ? blocks.filter(b => b && b.type === 'text').map(b => b.text).join('\n')
        : (typeof m.content === 'string' ? m.content : '');
      // Imagem enviada também aparece: sem isto o print some do transcript.
      const imgs = blocks ? blocks.filter(b => b && b.type === 'image' && b.data) : [];
      if (!text.trim() && !imgs.length) { userIdx--; userTexts.pop(); continue; }
      const urow = el('div', 'row user', '▸ ' + text.trim());
      urow.dataset.text = text.trim();
      // Âncora do restore: uma linha local só volta antes da 1ª mensagem mais nova.
      if (Number.isFinite(m.timestamp)) urow.dataset.at = String(m.timestamp);
      userTexts[userIdx] = text.trim();
      // Só no log principal: no transcript de child o fork valeria para outra sessão.
      if (!ctx) urow.appendChild(forkRowBtn({ uindex: userIdx, utext: text.trim() }, 'fork a partir desta mensagem (nova sessão, original preservada)'));
      imgs.forEach(b => urow.appendChild(thumb('data:' + (b.mimeType || 'image/png') + ';base64,' + b.data)));
      target.appendChild(urow);
      continue;
    }

    if (m.role === 'assistant') {
      if (!blocks) continue;
      for (const b of blocks) {
        if (!b) continue;
        if (b.type === 'thinking' && b.thinking && b.thinking.trim()) {
          target.appendChild(thinkBlock(b.thinking.slice(0, 20000)));
        } else if (b.type === 'text' && b.text && b.text.trim()) {
          const row = mdRow();
          setMarkdown(row.body, b.text.trim());
          // Fork daqui: ancora na user message que provocou esta resposta.
          // Só no log principal (ver comentário na user row).
          if (!ctx) row.root.appendChild(forkRowBtn({ uindex: userIdx, utext: userTexts[userIdx] || '' }, 'fork daqui (nova sessão a partir do prompt anterior)'));
          target.appendChild(row.root);
        } else if (b.type === 'toolCall') {
          card(b.id, b.name, b.arguments, { target, store }, m.timestamp);
        }
      }
      continue;
    }

    if (m.role === 'toolResult') {
      const entry = store.get(m.toolCallId) || card(m.toolCallId, m.toolName, null, { target, store }, m.timestamp);
      entry.root.classList.add(m.isError ? 'err' : 'ok');
      entry.icon.textContent = m.isError ? '✕' : '✓';
      applyToolResult(entry, m);
      if (uiSettings.expandTools) entry.root.classList.remove('collapsed');
      continue;
    }
  }
  if (target === $('log')) { restoreLocalRows(); reattachStream(); }
  if (ctx) target.scrollTop = 0;
  else { scrollBottom(true); updateScrollBtn(); }
}

/* =============== subagents: histórico do disco =============== */
function relTime(ms) {
  if (!ms) return '';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'agora';
  if (s < 3600) return Math.round(s / 60) + 'm';
  if (s < 86400) return Math.round(s / 3600) + 'h';
  return Math.round(s / 86400) + 'd';
}

const CHILD_STATE = {
  done: ['concluído', 'chip-done'],
  running: ['rodando', 'state-running'],
  unfinished: ['interrompido', 'chip-unfinished'],
  unknown: ['?', 'chip-unknown'],
};

function renderChildren(list) {
  lastDiskList = Array.isArray(list) ? list : [];
  paintSubs();
}

/* =============== painel: arquivos editados + diffs =============== */
/* Sem aba própria: `session_edits` alimenta o diff do painel Git (clique numa row
   que esteja na lista abre o patch com "desfazer hunk"). */
let editedFiles = []; // último resultado de session_edits ({file, tool, at, src, patch})

/* =============== diagnóstico: log circular das linhas RPC =============== */
/* Buffer circular (máx 200) preenchido no listener `rpc-line` existente e no
   par sendCommand/handleResponse, sem mudar o roteamento. Cada linha guarda
   comando, latência e resultado; a aba Diagnóstico só renderiza este buffer. */
const DIAG_MAX = 200;
const diagBuf = []; // {t, cmd, lat, res} — ordem de chegada, as mais novas por último
const diagPending = new Map(); // rpc id -> Date.now() do envio (para a latência)

function diagPush(cmd, lat, res) {
  diagBuf.push({ t: Date.now(), cmd: String(cmd == null ? '' : cmd).slice(0, 220), lat: lat || '—', res: res || '' });
  if (diagBuf.length > DIAG_MAX) diagBuf.splice(0, diagBuf.length - DIAG_MAX);
  if (!$('debug').classList.contains('hidden')) renderDiag();
}

function renderDiag() {
  const host = $('diaglist');
  if (!host) return;
  const head = $('diaghead');
  if (head) head.textContent = diagBuf.length + ' linha(s) (máx ' + DIAG_MAX + ')';
  clear(host);
  if (!diagBuf.length) { host.appendChild(el('div', 'empty', 'sem linhas RPC ainda')); return; }
  for (const e of diagBuf.slice().reverse()) {
    const row = el('div', 'file-row' + (String(e.res || '').startsWith('falhou') ? ' err' : ''));
    row.title = (e.cmd || '') + (e.res ? '\n' + e.res : '');
    row.appendChild(el('span', 'file-name', e.cmd || '—'));
    row.appendChild(el('span', 'file-dir', e.res || ''));
    row.appendChild(el('span', 'file-count', e.lat || '—'));
    host.appendChild(row);
  }
}

/* =============== painel direito: divisória arrastável =============== */
/* Sem abas comutáveis: subagents ficam em cima e o Git fixo embaixo. `--split`
   (no #rightpanel) é a altura da metade de baixo em % do painel; o clamp 20..80
   garante que nenhum dos dois lados desapareça. Um valor legado em
   localStorage['panel-pane'] é simplesmente ignorado. */
const SPLIT_DEFAULT = 50;
const SPLIT_MIN = 20;
const SPLIT_MAX = 80;

function setSplit(ratio, persist) {
  const pct = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, Number(ratio) || SPLIT_DEFAULT));
  const host = $('rightpanel');
  if (host) host.style.setProperty('--split', pct + '%');
  if (persist) { try { localStorage.setItem('split-ratio', String(pct)); } catch { /* sem storage */ } }
  return pct;
}

function initSplit() {
  let saved = SPLIT_DEFAULT;
  try { saved = Number(localStorage.getItem('split-ratio')) || SPLIT_DEFAULT; } catch { /* sem storage */ }
  setSplit(saved, false);
  const grip = $('splitgrip');
  if (!grip) return;
  let dragging = false;
  grip.addEventListener('mousedown', (e) => {
    e.preventDefault(); // sem isto o arrasto vira seleção de texto
    dragging = true;
    document.body.style.cursor = 'row-resize';
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const host = $('rightpanel');
    const box = host ? host.getBoundingClientRect() : null;
    if (!box || !box.height) return;
    // Altura da metade de baixo = distância da borda inferior do painel ao cursor.
    setSplit(((box.bottom - e.clientY) / box.height) * 100, false);
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    const host = $('rightpanel');
    setSplit(host ? parseFloat(host.style.getPropertyValue('--split')) : SPLIT_DEFAULT, true);
  });
}

/* =============== colunas laterais e largura do composer =============== */
/* Os dois grips verticais (`.col-grip`, dentro da `aside` e do `#rightpanel`) só
   capturam o ponteiro com Ctrl pressionado: `body.ctrl-held` liga o
   `pointer-events` deles no keydown. Sem Ctrl o clique atravessa para o conteúdo,
   então arrastar a borda não rouba clique de lista nem seleção de texto.
   As larguras ficam em px (não em %) para escalarem junto com o `zoom` do body;
   `usableWidth()` desconta o zoom ao comparar com a janela. */
const ASIDE_MIN = 180, ASIDE_MAX = 520;
const PANEL_MIN = 240, PANEL_MAX = 720;
const CENTER_MIN = 320;        // piso do composer/transcript entre as duas colunas
const COMPOSER_MIN = 520, COMPOSER_MAX = 1600, COMPOSER_DEFAULT = 820;
const COMPOSER_STEP = 40;      // px por passo de Ctrl+wheel sobre o composer
/* Partida do arrasto quando não há layout medido (primeira pintura, jsdom). */
const ASIDE_DEFAULT = 320, PANEL_DEFAULT = 340;

/** Clampa um número em [min, max]; valor não numérico cai no mínimo. */
export function clampWidth(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/** Colunas laterais sem espremer o centro: o excedente sobre `total - 320` sai das
    duas na proporção da folga de cada uma (quem está no teto não cede), e nenhuma
    desce do próprio piso. Se nem os pisos couberem, devolve os pisos. */
export function clampColumns(asidePx, panelPx, totalPx) {
  const aside = clampWidth(asidePx, ASIDE_MIN, ASIDE_MAX);
  const panel = clampWidth(panelPx, PANEL_MIN, PANEL_MAX);
  const total = Number(totalPx);
  if (!Number.isFinite(total) || total <= 0) return { aside, panel };
  const over = aside + panel + CENTER_MIN - total;
  if (over <= 0) return { aside, panel };
  const slackAside = aside - ASIDE_MIN;
  const slackPanel = panel - PANEL_MIN;
  const slack = slackAside + slackPanel;
  if (over >= slack) return { aside: ASIDE_MIN, panel: PANEL_MIN };
  return {
    aside: Math.floor(aside - over * (slackAside / slack)),
    panel: Math.floor(panel - over * (slackPanel / slack)),
  };
}

/** Fator do `zoom` aplicado no body (1 quando ausente/inválido). */
function zoomFactor() {
  const z = parseFloat(document.body.style.zoom);
  return Number.isFinite(z) && z > 0 ? z : 1;
}

/** Largura útil do layout em px de CSS (o zoom divide a janela). */
function usableWidth() {
  const vw = Number(window.innerWidth) || 0;
  return vw ? vw / zoomFactor() : 0;
}

/** Largura renderizada de uma coluna em px de CSS, já sem o zoom. */
function columnPx(id) {
  const node = $(id);
  const rect = node && node.getBoundingClientRect ? node.getBoundingClientRect() : null;
  const w = rect ? rect.width : 0;
  return w > 0 ? w / zoomFactor() : 0;
}

let colWanted = null;   // px de CSS pedidos pelo usuário (null = % padrão do CSS)
let composerWidth = 0;  // 0 = max-width padrão do CSS

function applyColumns(persist) {
  if (!colWanted) {
    colWanted = { aside: columnPx('sidebar') || ASIDE_DEFAULT, panel: columnPx('rightpanel') || PANEL_DEFAULT };
  }
  const fit = clampColumns(colWanted.aside, colWanted.panel, usableWidth());
  document.body.style.setProperty('--w-aside', Math.round(fit.aside) + 'px');
  document.body.style.setProperty('--w-panel', Math.round(fit.panel) + 'px');
  if (persist) {
    try {
      localStorage.setItem('w-aside', String(Math.round(fit.aside)));
      localStorage.setItem('w-panel', String(Math.round(fit.panel)));
    } catch { /* sem storage */ }
  }
  return fit;
}

function setComposerWidth(px, persist) {
  composerWidth = clampWidth(px, COMPOSER_MIN, COMPOSER_MAX);
  document.body.style.setProperty('--composer-w', Math.round(composerWidth) + 'px');
  if (persist) {
    try { localStorage.setItem('composer-w', String(Math.round(composerWidth))); } catch { /* sem storage */ }
  }
  return composerWidth;
}

/** Base do primeiro wheel: largura atual do card, ou o padrão do CSS se o jsdom
    (sem layout) não a resolve. */
function composerBasePx(card) {
  if (composerWidth) return composerWidth;
  const w = card && window.getComputedStyle ? parseFloat(window.getComputedStyle(card).maxWidth) : NaN;
  return Number.isFinite(w) && w > 0 ? w : COMPOSER_DEFAULT;
}

function readSavedPx(key) {
  try { return Number(localStorage.getItem(key)) || 0; } catch { return 0; }
}

/** Arrasto de uma borda. `side` diz qual var o movimento alimenta: a da esquerda
    cresce com o cursor (`x`), a da direita cresce ao contrário. */
function dragGrip(grip, side) {
  if (!grip) return;
  let drag = null;
  grip.addEventListener('pointerdown', (e) => {
    if (!e.ctrlKey || (e.button !== undefined && e.button !== 0)) return;
    e.preventDefault();
    if (grip.setPointerCapture) grip.setPointerCapture(e.pointerId);
    const base = colWanted || {
      aside: columnPx('sidebar') || ASIDE_DEFAULT,
      panel: columnPx('rightpanel') || PANEL_DEFAULT,
    };
    drag = { x: e.clientX, z: zoomFactor(), base: { aside: base.aside, panel: base.panel } };
  });
  grip.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const delta = (e.clientX - drag.x) / drag.z; // px de CSS: o body é escalado pelo zoom
    colWanted = side === 'aside'
      ? { aside: drag.base.aside + delta, panel: drag.base.panel }
      : { aside: drag.base.aside, panel: drag.base.panel - delta };
    applyColumns(false);
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    applyColumns(true);
  };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
}

function initColumnResize() {
  // Boot: reaplica o salvo antes do primeiro render (sem salvar de novo).
  const aside = readSavedPx('w-aside');
  const panel = readSavedPx('w-panel');
  if (aside || panel) {
    colWanted = { aside: aside || ASIDE_DEFAULT, panel: panel || PANEL_DEFAULT };
    applyColumns(false);
  }
  const composer = readSavedPx('composer-w');
  if (composer) setComposerWidth(composer, false);

  dragGrip($('colgripaside'), 'aside');
  dragGrip($('colgrippanel'), 'panel');

  // Ctrl libera o `pointer-events` dos grips (CSS não lê modificador).
  const syncCtrl = (e) => document.body.classList.toggle('ctrl-held', !!e.ctrlKey);
  document.addEventListener('keydown', syncCtrl);
  document.addEventListener('keyup', syncCtrl);
  window.addEventListener('blur', () => document.body.classList.remove('ctrl-held'));

  // Ctrl+wheel sobre o composer muda a largura máxima do card; fora dele o wheel
  // é do conteúdo (transcript) e não é interceptado.
  const card = document.querySelector('.composer-card');
  if (card) {
    card.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const step = e.deltaY < 0 ? COMPOSER_STEP : -COMPOSER_STEP;
      setComposerWidth(composerBasePx(card) + step, true);
    }, { passive: false });
  }

  // Janela menor (ou zoom maior) pode espremer o centro: re-clampa o que foi fixado.
  window.addEventListener('resize', () => { if (colWanted) applyColumns(false); });
}

/** Lê as edições do disco (sessão + children). Só roda com o painel Git visível:
    é dele que sai o diff com "desfazer hunk" para o arquivo clicado. */
async function loadEdits() {
  const file = current && current.file;
  const seq = viewSeq;
  if (!file) { editedFiles = []; return; }
  try {
    const list = JSON.parse(String(await inv('session_edits', { path: file })));
    if (seq !== viewSeq) return; // trocou de sessão durante a leitura
    editedFiles = Array.isArray(list) ? list : [];
  } catch {
    if (seq !== viewSeq) return;
    editedFiles = [];
  }
}

/** "a/b/c.dart" -> ["c.dart", "a/b"] (aceita separador do Windows). */
function splitPath(p) {
  const s = String(p || '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i < 0 ? [s, ''] : [s.slice(i + 1), s.slice(0, i)];
}

/** Mesmo arquivo depois de normalizar separador e `./` (cwd pode vir com `\\`). */
function samePath(a, b) {
  const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\.\//, '');
  return norm(a) === norm(b);
}

/** Grupo de edições da sessão para um path do git. `session_edits` guarda o
    caminho absoluto; o status do git é relativo ao `cwd`. */
function sessionEditsFor(path) {
  const cwd = String((current && current.cwd) || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const abs = cwd ? cwd + '/' + String(path || '').replace(/\\/g, '/') : String(path || '');
  const items = editedFiles.filter((e) => e && e.file && (samePath(e.file, abs) || samePath(e.file, path)));
  if (!items.length) return null;
  return { file: items[0].file, items, at: Math.max(...items.map((e) => Number(e.at) || 0)) };
}

/** Clique na row: edição da sessão (com desfazer) ou patch do git (só leitura). */
function openGitDiff(path) {
  const g = sessionEditsFor(path);
  if (g) { openDiffs(g); return; }
  openWorktreeDiff(path);
}

/** Patch do worktree (`git_file_diff`) no MESMO painel de detalhe; `file` null
    desliga o botão "desfazer hunk" do `renderPatch`. */
async function openWorktreeDiff(path) {
  const host = $('detaillog');
  const [name, dir] = splitPath(path);
  $('detailtitle').textContent = name + (dir ? '  ·  ' + dir : '');
  clear(host);
  host.appendChild(el('div', 'history-head', 'git diff · somente leitura'));
  const box = el('div', 'diff');
  const body = el('div', 'diff-body');
  box.appendChild(body);
  host.appendChild(box);
  body.appendChild(el('div', 'empty', 'lendo diff…'));
  $('detail').classList.remove('hidden');
  const seq = viewSeq;
  let patch = '';
  try {
    patch = String(await inv('git_file_diff', { cwd: current && current.cwd, path }));
  } catch (e) {
    if (seq !== viewSeq) return;
    clear(body);
    body.appendChild(el('div', 'empty', 'git diff: ' + e));
    return;
  }
  if (seq !== viewSeq) return; // trocou de sessão durante a leitura
  clear(body);
  if (!patch.trim()) { body.appendChild(el('div', 'empty', 'sem alterações no worktree')); return; }
  renderPatch(body, patch, null, path);
}

/** Abre o diff no mesmo painel de detalhe dos subagents. */
function openDiffs(g) {
  const host = $('detaillog');
  const [name, dir] = splitPath(g.file);
  $('detailtitle').textContent = name + (dir ? '  ·  ' + dir : '');
  clear(host);
  // Ações do arquivo (copiar caminho reusa o clipboard do sistema; abrir usa o app padrão).
  const actions = el('div');
  actions.style.cssText = 'display:flex;gap:6px;margin-bottom:8px;';
  const cp = el('button', 'tiny', 'copiar caminho');
  cp.onclick = () => copyText(cp, g.file);
  const op = el('button', 'tiny', 'abrir');
  op.onclick = async () => {
    try { await inv('open_file', { cwd: current && current.cwd, path: g.file }); }
    catch (e) { note('abrir: ' + e); }
  };
  actions.append(cp, op);
  host.appendChild(actions);
  // items já vem do mais novo para o mais antigo; inverte para ler a evolução.
  for (const e of g.items.slice().reverse()) {
    const box = el('div', 'diff');
    const head = el('div', 'diff-head');
    head.appendChild(el('span', 'tool-name', String(e.tool || 'edit')));
    head.appendChild(el('span', 'diff-file', String(e.src || '')));
    head.appendChild(el('span', 'tool-right', relTime(Number(e.at) || 0)));
    box.appendChild(head);
    const body = el('div', 'diff-body');
    renderPatch(body, e.patch, g.file);
    box.appendChild(body);
    host.appendChild(box);
  }
  $('detail').classList.remove('hidden');
}

/** Linhas com a coluna do diff (`+`, `-`, ` `): o código vem depois dela. */
const hasDiffPrefix = (cls, line) =>
  cls === 'diff-add' || cls === 'diff-del' || (cls === 'diff-ctx' && line[0] === ' ');

/* =============== vista do diff (unificada/split) =============== */

/** Re-renderiza todo diff vivo ao alternar a vista: painel de edições, git diff
    e cards de `edit`/`write` compartilham `.diff-body` + `node.diffArgs`. */
function refreshDiffs() {
  for (const node of document.querySelectorAll('.diff-body')) {
    const args = node.diffArgs;
    if (args) renderPatch(node, args.patch, args.file, args.langPath);
  }
}

function renderPatch(node, patch, file, langPath) {
  const text = String(patch || '');
  const lines = text.split('\n');
  clear(node);
  node.diffArgs = { patch, file, langPath };
  if (!text.trim()) {
    node.appendChild(el('div', 'diff-line diff-meta', 'sem diff (arquivo novo ou conteúdo não registrado)'));
    return;
  }
  const lang = langFor(langPath || file);
  const MAX = 1200;
  const truncated = text.includes('\u2026 patch truncado');
  const split = diffView() === 'split';
  const bar = el('div', 'diff-view-bar');
  const toggle = el('button', 'ghost', split ? 'vista unificada' : 'vista dividida');
  toggle.title = split ? 'mostrar em uma coluna' : 'mostrar lado a lado';
  toggle.onclick = () => {
    setDiffView(split ? 'unified' : 'split');
    refreshDiffs();
  };
  bar.appendChild(toggle);
  node.appendChild(bar);
  const host = split ? el('div', 'diff-split') : node;
  if (split) node.appendChild(host);
  // Separa o cabeçalho (---/+++) dos hunks (@@): um botão "desfazer" por hunk.
  // Patch sintético do `write` (só +) e patch truncado não ganham botão —
  // o backend recusaria mesmo, com erro legível.
  const groups = [];
  let cur = { head: [], hunk: null };
  for (const line of lines.slice(0, MAX)) {
    if (line.startsWith('@@')) {
      if (cur.hunk || cur.head.length) groups.push(cur);
      cur = { head: [], hunk: [] };
    }
    if (cur.hunk) cur.hunk.push(line);
    else cur.head.push(line);
  }
  groups.push(cur);
  const paint = (hostNode, line, wide) => {
    let cls = 'diff-ctx';
    if (line.startsWith('+++') || line.startsWith('---')) cls = 'diff-meta';
    else if (line.startsWith('@@')) cls = 'diff-hunk';
    else if (line.startsWith('+')) cls = 'diff-add';
    else if (line.startsWith('-')) cls = 'diff-del';
    const row = el('div', 'diff-line ' + cls + (wide ? ' diff-split-wide' : ''));
    if (!line.length) { row.textContent = ' '; hostNode.appendChild(row); return; }
    // Só add/del/ctx têm a coluna do prefixo; cabeçalho/hunk ficam texto puro.
    if (hasDiffPrefix(cls, line)) {
      row.appendChild(document.createTextNode(line[0]));
      appendHighlighted(row, line.slice(1), lang);
    } else {
      row.appendChild(document.createTextNode(line));
    }
    hostNode.appendChild(row);
  };
  // Célula da vista split: mesma pintura/prefixo do unified, lado pela classe.
  const paintCell = (cell, side) => {
    const cls = cell.kind === 'pad' ? 'diff-pad' : 'diff-' + cell.kind;
    const row = el('div', 'diff-line ' + cls + ' diff-' + side);
    if (!cell.text.length) { row.textContent = ' '; host.appendChild(row); return; }
    if (hasDiffPrefix(cls, cell.text)) {
      row.appendChild(document.createTextNode(cell.text[0]));
      appendHighlighted(row, cell.text.slice(1), lang);
    } else {
      row.appendChild(document.createTextNode(cell.text));
    }
    host.appendChild(row);
  };
  for (const g of groups) {
    for (const line of g.head) paint(host, line, split);
    if (!g.hunk) continue;
    const undoable = !truncated && file
      && g.hunk.some((l) => l.startsWith('-') && !l.startsWith('---'));
    if (undoable) {
      const hunkText = g.hunk.join('\n');
      const btn = el('button', 'tiny', 'desfazer hunk');
      btn.style.cssText = 'margin:2px 0 6px;';
      if (split) btn.classList.add('diff-split-wide');
      btn.onclick = async () => {
        if (!confirm('Desfazer este hunk em ' + file + '?')) return;
        btn.disabled = true;
        try {
          const res = await inv('revert_hunk', { cwd: current && current.cwd, file, hunk: hunkText });
          note(String(res));
          loadEdits();
        } catch (e) { note('reverter: ' + e); btn.disabled = false; }
      };
      host.appendChild(btn);
    }
    if (split) {
      for (const pair of splitHunk(g.hunk)) {
        if (pair.hunk !== undefined) paint(host, pair.hunk, true);
        else { paintCell(pair.left, 'left'); paintCell(pair.right, 'right'); }
      }
    } else {
      for (const line of g.hunk) paint(host, line, false);
    }
  }
  if (lines.length > MAX) {
    node.appendChild(el('div', 'diff-line diff-meta', '… ' + (lines.length - MAX) + ' linha(s) omitida(s)'));
  }
}

/* =============== painel: missões (somente leitura, sem runner) =============== */
let missionsList = []; // último resultado de missions_status ({project,id,title,status,updatedAt,runs,cwd})
let missionsError = '';

async function loadMissions() {
  try {
    const list = JSON.parse(String(await inv('missions_status')));
    missionsList = Array.isArray(list) ? list : [];
    missionsError = '';
  } catch (e) {
    missionsList = [];
    missionsError = String(e);
  }
  renderMissions();
}

function renderMissions() {
  const host = $('missions');
  clear(host);
  if (missionsError) { host.appendChild(el('div', 'empty', missionsError)); return; }
  if (!missionsList.length) {
    host.appendChild(el('div', 'empty', 'nenhuma missão no disco')); return;
  }
  host.appendChild(el('div', 'history-head', missionsList.length + ' missão(ões)'));
  for (const m of missionsList) {
    const row = el('div', 'file-row');
    row.title = String(m.cwd || m.project || '');
    row.appendChild(el('span', 'file-name', String(m.title || m.id || 'sem título')));
    row.appendChild(el('span', 'file-dir', String(m.status || '')));
    row.appendChild(el('span', 'file-count', String(m.runs || 0)));
    row.onclick = () => openMission(m);
    host.appendChild(row);
  }
}

/** Detalhe da missão no mesmo painel dos diffs (só mostra, não executa). */
function openMission(m) {
  const host = $('detaillog');
  $('detailtitle').textContent = String(m.title || m.id || 'missão');
  clear(host);
  host.appendChild(el('div', 'history-head',
    String(m.status || '?') + ' · ' + String(m.runs || 0) + ' run(s)'));
  for (const [k, v] of [['projeto', m.cwd || m.project], ['id', m.id], ['atualizada', m.updatedAt]]) {
    host.appendChild(el('div', 'row note', k + ': ' + (v || '—')));
  }
  $('detail').classList.remove('hidden');
}

/* =============== painel: git (status/diff + escrita) =============== */
let gitData = null; // último payload de git_status ({repo,branch,ahead,behind,detached,changes,totals})
let gitError = '';
/* Seleção da lista = intenção da ação: `commit` e `descartar` agem sobre estes
   paths. O clique na row marca/desmarca; abrir o diff é o botão `diff` da row
   (clique simples ambíguo: marcar ou abrir? — dois alvos explícitos). */
let gitSel = new Set();
let gitCwd = '';   // dono da seleção/rascunho; trocar de sessão zera os dois
let gitNote = '';  // resultado da última ação, na linha de status do painel
let gitNoteErr = false;
let gitMsg = '';   // rascunho da mensagem de commit (sobrevive ao re-render)
let gitAmend = false;
let gitLease = false; // toggle explícito: só ele habilita --force-with-lease
let gitBusy = false;  // ação em voo: trava duplo clique

/* O status vem do disco: atualiza sozinho a cada 5 s (pausado com a janela
   oculta e durante ação de escrita). Um `git status` custa ms — watcher nativo
   de fs não se paga aqui. */
let gitPoll = null;
function startGitPoll() {
  if (gitPoll) return;
  gitPoll = setInterval(() => {
    if (document.hidden || gitBusy) return;
    if (current && current.cwd) loadGit();
  }, 5000);
}

async function loadGit() {
  const cwd = current && current.cwd;
  const seq = viewSeq;
  if (!cwd) { gitData = null; gitError = ''; renderGit(); return; }
  try {
    const data = JSON.parse(String(await inv('git_status', { cwd })));
    if (seq !== viewSeq) return; // trocou de sessão durante a leitura
    gitData = data && typeof data === 'object' ? data : null;
    gitError = '';
  } catch (e) {
    if (seq !== viewSeq) return;
    gitData = null;
    gitError = String(e);
  }
  renderGit();
}

/** Executa uma ação de escrita do painel: marca "em voo", pinta o resultado na
    linha de status (nunca `alert`) e relê o status no fim. */
async function gitAct(label, call, opts) {
  const cwd = String((current && current.cwd) || '');
  if (!cwd || gitBusy) return null;
  gitBusy = true;
  gitNote = label + '…';
  gitNoteErr = false;
  renderGit();
  try {
    const out = String((await call(cwd)) || '').trim();
    gitNote = label + ' ok' + (out ? ': ' + out : '');
    gitNoteErr = false;
    return { ok: true, out };
  } catch (e) {
    gitNote = label + ' falhou: ' + String(e).trim();
    gitNoteErr = true;
    return { ok: false, err: String(e) };
  } finally {
    gitBusy = false;
    if (opts && opts.clearSel) gitSel.clear();
    await loadGit();
  }
}

/** `descartar`: `git restore` dos marcados. Untracked é recusado no backend (o
    equivalente seria `git clean`), e o erro aparece na linha de status. */
async function gitDiscardSelected() {
  const paths = [...gitSel];
  if (!paths.length) return;
  const ok = confirm('descartar ' + paths.length + ' arquivo(s)?\n\n' + paths.join('\n')
    + '\n\ngit restore -- (só rastreados; não tem desfazer)');
  if (!ok) return;
  await gitAct('descartar', (cwd) => inv('git_discard', { cwd, paths }), { clearSel: true });
}

function gitStash() {
  return gitAct('stash', (cwd) => inv('git_stash', { cwd }), { clearSel: true });
}

function gitStashPop() {
  return gitAct('stash pop', (cwd) => inv('git_stash_pop', { cwd }), { clearSel: true });
}

/** `pull` só fast-forward: sem upstream ou non-fast-forward o stderr do git vai
    para a linha de status; não há confirmação porque nada local é descartado. */
function gitPull() {
  return gitAct('pull', (cwd) => inv('git_pull', { cwd }));
}

/** Confirma o comando literal do force (só existe atrás do toggle). */
function gitConfirmLease(cwd) {
  return confirm('git push --force-with-lease\n\nno repositório ' + cwd + '?');
}

/** `commit` (ou `commit & push`): estágia os marcados e commita; com push, uma
    falha do push NÃO desfaz o commit — o stderr do git vai para a linha. */
async function gitCommit(push) {
  const cwd = String((current && current.cwd) || '');
  const message = gitMsg;
  const paths = [...gitSel];
  if (!message.trim()) {
    gitNote = 'mensagem vazia — nada foi commitado';
    gitNoteErr = true;
    renderGit();
    return;
  }
  if (push && gitLease && !gitConfirmLease(cwd)) return;
  const label = push ? 'commit & push' : 'commit';
  await gitAct(label, async (dir) => {
    const hash = String(await inv('git_commit', { cwd: dir, message, paths, amend: gitAmend }));
    gitMsg = '';      // a mensagem foi consumida: o próximo commit começa limpo
    gitAmend = false;
    if (!push) return hash;
    try {
      const out = String(await inv('git_push', { cwd: dir, forceWithLease: gitLease }));
      return hash + ' · push: ' + (out || 'ok');
    } catch (e) {
      throw new Error('commit ' + hash + ' feito, push falhou — ' + String(e));
    }
  }, { clearSel: true });
}

async function gitPush() {
  const cwd = String((current && current.cwd) || '');
  if (gitLease && !gitConfirmLease(cwd)) return;
  await gitAct(gitLease ? 'push --force-with-lease' : 'push',
    (dir) => inv('git_push', { cwd: dir, forceWithLease: gitLease }));
}

/** Checkbox com rótulo (o `<label>` faz o texto também alternar a caixa). */
function gitCheck(text, on, title, onchange) {
  const lab = el('label', 'git-check');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = !!on;
  box.onchange = () => onchange(box.checked);
  lab.appendChild(box);
  lab.appendChild(el('span', null, text));
  if (title) { lab.title = title; box.title = title; }
  return lab;
}

function renderGit() {
  const host = $('git');
  if (!host) return;
  const repo = !!gitData && gitData.repo === true;
  const list = repo && Array.isArray(gitData.changes) ? gitData.changes : [];
  const cnt = $('gitcnt');
  if (cnt) cnt.textContent = list.length ? String(list.length) : '';
  const cwdTxt = String((current && current.cwd) || '');
  if (cwdTxt !== gitCwd) { // outra sessão: seleção/mensagem de commit não valem
    gitCwd = cwdTxt;
    gitSel.clear();
    gitMsg = '';
    gitNote = '';
  }
  // Re-render (loadGit roda a cada ação/edição) não pode roubar o cursor de quem
  // está escrevendo a mensagem: guarda foco e posição e devolve no fim.
  const prevMsgEl = document.getElementById('gitmsg');
  const msgFocused = !!prevMsgEl && document.activeElement === prevMsgEl;
  const msgCaret = msgFocused ? prevMsgEl.selectionStart : 0;

  clear(host);
  if (gitError) { host.appendChild(el('div', 'empty', gitError)); return; }
  if (!repo) {
    host.appendChild(el('div', 'empty', cwdTxt ? 'sem repositório git em ' + cwdTxt : 'nenhuma sessão aberta'));
    return;
  }
  const t = gitData.totals || {};
  const head = el('div', 'history-head');
  const branch = String(gitData.branch || '') || (gitData.detached ? '(detached)' : '—');
  head.appendChild(el('span', null, branch));
  head.appendChild(el('span', null, ' · ↑' + (Number(gitData.ahead) || 0) + ' ↓' + (Number(gitData.behind) || 0)));
  head.appendChild(el('span', null, ' · ' + list.length + ' arquivo(s) '));
  head.appendChild(el('span', 'git-add', '+' + (Number(t.add) || 0)));
  head.appendChild(el('span', null, ' '));
  head.appendChild(el('span', 'git-del', '−' + (Number(t.del) || 0)));
  host.appendChild(head);
  // Caminho e estado limpo explícitos: sem isso, repo sem mudanças e "nada carregou"
  // ficam idênticos na tela (bug reportado 2026-11-16).
  if (cwdTxt) host.appendChild(el('div', 'file-dir', cwdTxt));

  const bar = el('div', 'git-bar');
  const btn = (label, title, onclick, cls) => {
    const b = el('button', cls || 'ghost', label);
    b.title = title;
    b.onclick = onclick;
    bar.appendChild(b);
    return b;
  };
  btn('atualizar', 'relê o git status', () => loadGit());
  const discardBtn = btn('descartar', 'git restore dos selecionados (só rastreados)', gitDiscardSelected);
  discardBtn.disabled = !gitSel.size;
  btn('stash', 'git stash push --include-untracked (tudo, com untracked)', gitStash);
  btn('stash pop', 'git stash pop (conflito aparece na linha de status)', gitStashPop);
  btn('pull', 'git pull --ff-only (falha aparece na linha de status)', gitPull);
  host.appendChild(bar);

  if (!list.length) {
    host.appendChild(el('div', 'empty', 'repositório limpo — nenhuma mudança no worktree'));
  }
  for (const c of list) {
    const path = String(c.path || '');
    const [name, dir] = splitPath(path);
    const row = el('div', 'file-row');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = gitSel.has(path);
    box.title = 'selecionar para commit/descartar';
    row.appendChild(box);
    row.appendChild(el('span', 'file-name', name));
    row.appendChild(el('span', 'file-dir', dir));
    row.appendChild(el('span', 'file-count', String(c.status || '?')));
    if (typeof c.add === 'number' || typeof c.del === 'number') {
      row.appendChild(el('span', 'git-add', '+' + (Number(c.add) || 0)));
      row.appendChild(el('span', 'git-del', '−' + (Number(c.del) || 0)));
    }
    const diffBtn = el('button', 'ghost', 'diff');
    diffBtn.title = 'abrir o diff deste arquivo';
    diffBtn.onclick = (e) => { e.stopPropagation(); openGitDiff(path); };
    row.appendChild(diffBtn);
    row.title = path + ' · ' + (c.untracked ? 'não rastreado' : (c.staged ? 'no índice' : 'no worktree'))
      + ' · clique na row seleciona; `diff` abre o patch';
    row.onclick = () => {
      if (gitSel.has(path)) gitSel.delete(path); else gitSel.add(path);
      box.checked = gitSel.has(path);
      discardBtn.disabled = !gitSel.size;
    };
    host.appendChild(row);
  }

  // Linha de status da última ação: sem `alert`, dentro do painel. Só existe
  // quando há algo a dizer (não há regra CSS genérica para `.hidden` aqui).
  if (gitNote) {
    const note = el('div', 'empty', gitNote);
    note.id = 'gitnote';
    if (gitNoteErr) note.style.color = 'var(--err)';
    host.appendChild(note);
  }

  const comp = el('div', 'git-composer');
  const ta = el('textarea');
  ta.id = 'gitmsg';
  ta.placeholder = 'mensagem do commit · Ctrl+Enter commita';
  ta.value = gitMsg;
  ta.oninput = () => { gitMsg = ta.value; };
  ta.onkeydown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); gitCommit(false); }
  };
  comp.appendChild(ta);

  const cbar = el('div', 'git-bar');
  cbar.appendChild(gitCheck('amend', gitAmend, 'git commit --amend -m (troca a mensagem do último commit)',
    (on) => { gitAmend = on; }));
  cbar.appendChild(gitCheck('--force-with-lease', gitLease,
    'só liga `git push --force-with-lease`; pede confirmação com o comando literal',
    (on) => { gitLease = on; }));
  const mkBtn = (label, title, onclick, cls) => {
    const b = el('button', cls || 'ghost', label);
    b.title = title;
    b.onclick = onclick;
    cbar.appendChild(b);
    return b;
  };
  mkBtn('commit', 'estágia os selecionados e commita (Ctrl+Enter)', () => gitCommit(false), 'primary');
  mkBtn('commit & push', 'commit e depois push; se o push falhar o commit fica', () => gitCommit(true));
  mkBtn('push', 'git push (--force-with-lease se o toggle estiver ligado)', gitPush);
  comp.appendChild(cbar);
  host.appendChild(comp);

  if (msgFocused && ta) {
    ta.focus();
    try { ta.setSelectionRange(msgCaret, msgCaret); } catch { /* sem seleção no tipo */ }
  }
}

/* =============== aba Plano (plans/ do projeto) =============== */
let plansData = null;   // último `plans_list` da sessão em foco (null = ainda não leu)
let plansError = '';

/** Relê os planos do `cwd` da sessão. Mesma geração (`viewSeq`) dos vizinhos:
    resposta de sessão que já saiu não pinta no painel da atual. */
async function loadPlans() {
  const cwd = current && current.cwd;
  const seq = viewSeq;
  if (!cwd) { plansData = null; plansError = ''; renderPlans(); return; }
  try {
    const data = JSON.parse(String(await inv('plans_list', { cwd })));
    if (seq !== viewSeq) return; // trocou de sessão durante a leitura
    plansData = data && typeof data === 'object' ? data : null;
    plansError = '';
  } catch (e) {
    if (seq !== viewSeq) return;
    plansData = null;
    plansError = String(e);
  }
  renderPlans();
}

/** Uma linha por plano (`name`, `done/total`, próximo item aberto) + barra de 2px.
    Clique na linha abre o markdown no app padrão. */
function renderPlans() {
  const host = $('plans');
  if (!host) return;
  clear(host);
  if (plansError) { host.appendChild(el('div', 'empty', plansError)); return; }
  if (!plansData) { host.appendChild(el('div', 'empty', 'nenhum plano')); return; }
  if (plansData.repo !== true) {
    host.appendChild(el('div', 'empty', 'nenhum plano encontrado (plans/, docs/spec, PLAN.md…)'));
    return;
  }
  const list = Array.isArray(plansData.plans) ? plansData.plans : [];
  if (!list.length) { host.appendChild(el('div', 'empty', 'nenhum plano')); return; }
  const cwd = current && current.cwd;
  for (const p of list) {
    const file = String(p.file || '');
    const done = Number(p.done) || 0;
    const total = Number(p.total) || 0;
    const item = el('div', 'plan-item');
    const row = el('div', 'file-row');
    row.appendChild(el('span', 'file-name', String(p.name || file)));
    if (p.source) row.appendChild(el('span', 'plan-source', String(p.source)));
    if (p.current) row.appendChild(el('span', 'plan-current', String(p.current)));
    row.appendChild(el('span', 'file-count', total ? done + '/' + total : 'sem checklist'));
    item.appendChild(row);
    const bar = el('div', 'plan-bar');
    const fill = el('div', 'plan-bar-fill');
    fill.style.width = (total ? Math.min(100, Math.round((done / total) * 100)) : 0) + '%';
    bar.appendChild(fill);
    item.appendChild(bar);
    item.title = file + ' · clique abre no app padrão';
    item.onclick = async () => {
      try { await inv('open_file', { cwd, path: file }); }
      catch (e) { plansError = 'abrir: ' + String(e); renderPlans(); }
    };
    host.appendChild(item);
  }
}

async function loadChildren(dir) {
  if (!dir) return;
  const seq = viewSeq;
  try {
    const list = JSON.parse(await inv('list_children', { dir }));
    // Comparar só a geração não basta: `switchTab` chama isto DEPOIS do await do
    // histórico, então a leitura nasce já com a geração nova e pintaria os runs da
    // aba anterior no painel da atual (bug: ir numa sessão com subagents e voltar).
    if (seq !== viewSeq || !current || current.childrenDir !== dir) return;
    // Vazio também renderiza: o paint fundido mantém o widget ao vivo visível.
    renderChildren(list);
  } catch (e) {
    if (seq !== viewSeq) return;
    setEmpty($('subs'), String(e));
  }
}

/* =============== subagents: ao vivo =============== */
function extractSnapshot(line) {
  const i = line.indexOf(PREFIX);
  if (i < 0) return null;
  const rest = line.slice(i + PREFIX.length);
  let end = -1, backslashes = 0;
  for (let k = 0; k < rest.length; k++) {
    const ch = rest[k];
    if (ch === '\\') { backslashes++; continue; }
    if (ch === '"' && backslashes % 2 === 0) { end = k; break; }
    backslashes = 0;
  }
  if (end < 0) return null;
  try { return JSON.parse(JSON.parse('"' + rest.slice(0, end) + '"')); }
  catch { return null; }
}

function fmtElapsed(from, to) {
  if (!from) return '';
  const s = Math.max(0, Math.round(((to || Date.now()) - from) / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm' + String(s % 60).padStart(2, '0');
  return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0');
}

let lastSnap = null; // último widget ao vivo (runs em andamento), por sessão em foco
let lastDiskList = null; // último histórico do disco, da sessão em foco

function liveRunBox(run, now) {
  const state = String(run.state || '?');
  const box = el('div', 'run');
  const head = el('div', 'run-head');
  head.appendChild(el('span', 'run-label', String(run.label || run.kind || 'run')));
  head.appendChild(el('span', 'state state-' + state, state));
  head.appendChild(el('span', 'tool-right', fmtElapsed(run.startedAt, run.updatedAt || now)));
  box.appendChild(head);

  for (const ch of run.children || []) {
    const line = el('div', 'child');
    line.appendChild(el('b', null, String(ch.label || ch.agent || ch.id)));
    line.appendChild(el('span', null, ' · ' + String(ch.state || '?')));
    if (ch.model) line.appendChild(el('span', null, ' · ' + ch.model.split('/').pop()));
    if (ch.thinking) line.appendChild(el('span', null, ' · ' + ch.thinking));
    box.appendChild(line);
  }
  return box;
}

function diskRunBox(c) {
  const box = el('div', 'run clickable');
  box.title = c.id;
  box.onclick = () => openChild(c);
  const head = el('div', 'run-head');
  head.appendChild(el('span', 'run-label', c.label || c.id.slice(0, 8)));

  const meta = CHILD_STATE[c.state] || CHILD_STATE.unknown;
  head.appendChild(el('span', 'state ' + meta[1], meta[0]));
  head.appendChild(el('span', 'tool-right', c.run + ' · ' + relTime(c.mtime)));
  box.appendChild(head);
  return box;
}

/* Dedupe conservador: só esconde o item do disco se o id for exatamente igual ao
   do run ao vivo. O formato de run.id do widget não é verificado (produtor é a
   extensão externa pi-subagents), então igualdade frouxa poderia sumir com item. */
function sameSub(r, c) {
  return !!r && !!c && r.id != null && c.id != null && String(r.id) === String(c.id);
}

/* Ao vivo e histórico se fundem: cada fonte atualiza só o seu estado e o paint
   desenha as duas metades. Antes um apagava o outro — o snapshot do widget limpava
   o histórico do disco a cada update ("aparece e depois fica só esse"). */
function paintSubs() {
  const host = $('subs');
  if (!host) return;
  const live = (lastSnap && Array.isArray(lastSnap.runs)) ? lastSnap.runs : [];
  const disk = (lastDiskList || []).filter(c => !live.some(r => sameSub(r, c)));
  clear(host);
  if (!live.length && !disk.length) {
    setEmpty(host, noSubsMessage());
    applySubsWarning();
    return;
  }
  const now = Date.now();
  for (const run of live) host.appendChild(liveRunBox(run, now));
  if (disk.length) {
    host.appendChild(el('div', 'history-head', 'histórico · ' + disk.length + ' run(s)'));
    for (const c of disk) host.appendChild(diskRunBox(c));
  }
}

function renderSubs(snap) {
  lastSnap = (snap && Array.isArray(snap.runs) && snap.runs.length) ? snap : null;
  paintSubs();
}

/* =============== fila de mensagens =============== */
/* `queue_update` traz a fila completa a cada mudança (docs/json.md) e é o único
   sinal de que uma mensagem enfileirada foi entregue. As linhas locais moram na
   aba porque o log é reconstruído do disco, que ainda não tem a mensagem. */
function localRows(t) { return t ? (t.localRows || (t.localRows = [])) : []; }

function queueTag(row, text, cls) {
  let tag = row.querySelector('.queue-tag');
  if (!tag) { tag = el('span', 'queue-tag'); row.appendChild(tag); }
  tag.className = 'queue-tag' + (cls ? ' ' + cls : '');
  tag.textContent = text;
}

function markRow(entry, state) {
  entry.state = state;
  entry.row.classList.toggle('queued', state === 'queued');
  // Cancelada também no nível da row: quando o render a reinsere no meio do
  // transcript, ela não pode se confundir com mensagem de fato enviada.
  entry.row.classList.toggle('cancelled', state === 'cancelled');
  if (state === 'queued') queueTag(entry.row, '· na fila');
  else if (state === 'delivered') queueTag(entry.row, '· entregue', 'delivered');
  else if (state === 'cancelled') queueTag(entry.row, '· cancelada', 'cancelled');
}

function syncQueue(key, texts) {
  const t = tabs.find(x => x.key === key);
  if (!t) return;
  const left = texts.slice();
  t.queue = texts;
  for (const entry of t.localRows || []) {
    if (entry.state !== 'queued') continue;
    const i = left.findIndex(s => s === entry.text || s.includes(entry.text) || entry.text.includes(s));
    if (i >= 0) left.splice(i, 1);
    else markRow(entry, 'delivered');
  }
}

/* Posição cronológica dentro do log. Insere antes da 1ª row mais nova que `at`;
   sem âncora (transcript inteiro mais antigo, ou `at` desconhecido) vai para o fim. */
export function insertRowByAt(log, row, at) {
  const cut = Number(at);
  for (const child of Array.from(log.children)) {
    const raw = child.dataset ? child.dataset.at : undefined;
    const childAt = raw === undefined || raw === '' ? NaN : Number(raw);
    if (Number.isFinite(childAt) && childAt > cut) { log.insertBefore(row, child); return; }
  }
  log.appendChild(row);
}

/* Regra do restore: o que conta é o texto, não o estado. Linha cancelada cujo texto
   já está no transcript era a mesma mensagem — reinseri-la a prendia no fim do log
   para sempre (bug: mensagem antiga reaparecendo no fim do transcript). */
export function shouldRestoreLocalRow(entry, seen) {
  return !!(entry && seen) && !seen.has(entry.text);
}

/** Acumula `delta` em `prev` mantendo no máximo os `cap` últimos caracteres.
 *  O corte não pode começar no meio de um par substituto (emoji fora do BMP). */
export function appendCapped(prev, delta, cap) {
  const next = String(prev == null ? '' : prev) + String(delta == null ? '' : delta);
  if (!(cap > 0) || next.length <= cap) return next;
  let start = next.length - cap;
  const code = next.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start += 1;
  return next.slice(start);
}

/* =============== saúde das extensões (LSP/MCP) =============== */
/* O pi avisa problema de extensão em texto no RPC (`extensão LSP inactive`,
   `extensão MCP servers need attention: …`). Até aqui isso caía no transcript como
   linha crua e nada virava estado; o chip do header é ADICIONAL (as linhas continuam
   no log). O casamento é por texto porque o pi não emite evento tipado para isso e o
   resto da frase varia com versão/idioma — só `LSP`/`MCP` são estáveis. */
const HEALTH_MAX = 20;      // avisos guardados por sessão (descarta o mais antigo)
const HEALTH_TITLE_MAX = 3; // mensagens listadas no tooltip
const HEALTH_ID_MAX = 200;  // corte do `id`: linha inteira não cabe num title

const HEALTH_RULES = [
  { kind: 'lsp', re: /extensão LSP|LSP inactive|lsp.*inactive/i },
  { kind: 'mcp', re: /MCP servers need attention|mcp.*failed|failed:.*fetch failed/i },
];
/* Prefixo de log (`[12:34:56] `, `2026-01-02T12:34:56Z `) não é mensagem: sai antes do
   casamento e do `id`, senão a mesma frase repetida viraria dois avisos. */
const HEALTH_TS = /^\s*(?:\[?\d{2}:\d{2}(?::\d{2})?\]?|\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)\s+/;

/** Avisos por sessão: `Map<sessionKey, Map<id, kind>>` (o interno é FIFO por inserção). */
const healthBySession = new Map();

/** Texto a classificar: a própria linha, ou a mensagem de um notify de extensão.
 *  O aviso do pi chega das duas formas: texto no stdout e `extension_ui_request`
 *  (`method: notify|setStatus`) — é esse JSON que pinta a linha "extensão …" no
 *  transcript. Olhar só o JSON de extensão evita casar regex em args de tool ou em
 *  texto do modelo. */
function healthText(line) {
  const text = stripAnsi(line).replace(HEALTH_TS, '').trim();
  if (!text.startsWith('{')) return text;
  let rec = null;
  try { rec = JSON.parse(text); } catch { return ''; }
  if (!rec || rec.type !== 'extension_ui_request') return '';
  const msg = typeof rec.message === 'string' ? rec.message : rec.statusText;
  return typeof msg === 'string' ? stripAnsi(msg).trim() : '';
}

/** Classifica uma linha de saúde do CLI: `{kind, id}` ou `null`.
 *  `id` é o texto normalizado (sem ANSI, sem prefixo de hora, espaços colapsados) —
 *  é a chave de deduplicação, não o texto exibido. */
export function classifyHealthLine(line) {
  if (typeof line !== 'string') return null;
  const text = healthText(line);
  if (!text) return null;
  const rule = HEALTH_RULES.find(r => r.re.test(text));
  if (!rule) return null;
  return { kind: rule.kind, id: text.replace(/\s+/g, ' ').slice(0, HEALTH_ID_MAX) };
}

/** Mapa `id -> kind` da sessão, criado sob demanda. */
function healthMapFor(sessionKey) {
  let map = healthBySession.get(sessionKey);
  if (!map) { map = new Map(); healthBySession.set(sessionKey, map); }
  return map;
}

/** Registra a linha no mapa (dedup por `id`) e devolve o `kind` reconhecido, ou `null`.
 *  Acima de `HEALTH_MAX` avisos o mais antigo sai: o chip mostra a contagem, não a lista. */
export function noteHealth(map, line) {
  const hit = classifyHealthLine(line);
  if (!hit || !(map instanceof Map)) return hit ? hit.kind : null;
  if (!map.has(hit.id)) {
    map.set(hit.id, hit.kind);
    while (map.size > HEALTH_MAX) map.delete(map.keys().next().value);
  }
  return hit.kind;
}

/** Estado do chip para um mapa de avisos: `{count, kinds, title}`.
 *  `kinds` sai na ordem de chegada; `title` lista no máximo `HEALTH_TITLE_MAX`
 *  mensagens e resume o resto em `… +N`. */
export function healthChipState(map) {
  const entries = map instanceof Map ? Array.from(map.entries()) : [];
  const kinds = [];
  for (const [, kind] of entries) if (!kinds.includes(kind)) kinds.push(kind);
  if (!entries.length) return { count: 0, kinds, title: '' };
  const lines = entries.slice(0, HEALTH_TITLE_MAX).map(([id, kind]) => kind + ': ' + id);
  if (entries.length > HEALTH_TITLE_MAX) lines.push('… +' + (entries.length - HEALTH_TITLE_MAX) + ' aviso(s)');
  return {
    count: entries.length,
    kinds,
    title: [entries.length + ' aviso(s) de extensão · clique para abrir o Diagnóstico', ...lines].join('\n'),
  };
}

/** Repinta o chip do header com os avisos da sessão ATUAL; sem sessão fica escondido. */
function renderHealthChip() {
  const chip = $('healthchip');
  if (!chip) return null;
  const st = healthChipState(current ? healthBySession.get(current.key) : null);
  // mcp pesa mais: servidor de MCP quebrado derruba tool, LSP inativo só tira refino.
  const warn = st.kinds.includes('mcp');
  chip.classList.toggle('hidden', !st.count);
  chip.classList.toggle('warn', !!st.count && warn);
  chip.classList.toggle('mute', !!st.count && !warn);
  chip.textContent = st.count ? '⚠ ' + st.count : '';
  chip.title = st.title;
  return st;
}

/* Reanexa linhas locais que o histórico do disco ainda não tem. Roda depois do
   render do log principal, então `seen` só contém linhas vindas do disco
   (`data-local` fica de fora): quando a mensagem já foi persistida, a cópia local cai. */
function restoreLocalRows() {
  const t = tabs.find(x => current && x.key === current.key);
  if (!t || !t.localRows || !t.localRows.length) return;
  const log = $('log');
  const seen = new Set(Array.from(log.querySelectorAll('.row.user:not([data-local])')).map(n => n.dataset.text));
  t.localRows = t.localRows.filter((entry) => {
    if (!shouldRestoreLocalRow(entry, seen)) return false;
    if (!entry.row.isConnected) insertRowByAt(log, entry.row, entry.at);
    return true;
  });
}

/* =============== eventos =============== */

/** Delta de um `message_update` do tipo pedido, ou '' se a linha não for isso. */
function deltaOf(line, type) {
  try {
    const d = JSON.parse(line).assistantMessageEvent;
    return d && d.type === type && typeof d.delta === 'string' ? d.delta : '';
  } catch { return ''; }
}

function scheduleStreamRender() {
  if (pendingRender) return;
  pendingRender = requestAnimationFrame(() => {
    pendingRender = 0;
    if (stream && stream.node) setMarkdown(stream.node, stream.text);
  });
}

listen('rpc-line', (ev) => {
  const [sessionId, line] = ev.payload;
  // Vigia do turno: toda linha da sessão é sinal de vida, inclusive de aba de fundo.
  const liveTab = tabs.find(x => x.key === sessionId);
  if (liveTab) liveTab.lastEventAt = Date.now();
  // Diagnóstico: só registra no buffer circular; o roteamento abaixo não muda.
  try {
    const rec = JSON.parse(line);
    const fg = current && sessionId === current.key ? 'atual' : 'fundo';
    diagPush(rec.type || rec.command || line.slice(0, 120), '—', rec.command ? ((rec.success ? 'ok' : 'falhou') + ' · ' + fg) : (String(rec.type || 'evento') + ' · ' + fg));
  } catch { diagPush(line.slice(0, 160), '—', 'raw'); }
  // Aviso de extensão vale para a aba que o emitiu, inclusive de fundo: o chip só
  // aparece quando aquela aba está em foco (o mapa é por sessão).
  if (noteHealth(healthMapFor(sessionId), line) && current && sessionId === current.key) renderHealthChip();
  // Resposta da sonda vale para aba em foco e de fundo: fica antes do split e nunca
  // cai no `handleResponse` (get_state da sonda não é o estado da sessão da view).
  if (line.includes('"type":"response"')) {
    let probe = null;
    try { probe = JSON.parse(line); } catch { /* linha crua */ }
    const pid = probe ? String(probe.id || '') : '';
    if (pid.startsWith(PROBE_PREFIX)) { reconcileTurn(pid.slice(PROBE_PREFIX.length), probe); return; }
  }
  if (!current || sessionId !== current.key) {
    // A fila muda também em aba de segundo plano: sem isto o estado nunca sairia de
    // "na fila" ao voltar para a aba.
    if (line.includes('"type":"queue_update"')) {
      let rec = null;
      try { rec = JSON.parse(line); } catch { return; }
      syncQueue(sessionId, [].concat(rec.steering || [], rec.followUp || []));
      return;
    }
    // Aba em segundo plano: o transcript dela volta por get_messages, mas o estado do
    // turno precisa sobreviver à troca — senão o indicador congela no rótulo antigo.
    if (line.includes('"type":"agent_settled"')) {
      maybeNotifyDone(sessionId);
      setTurn(sessionId, false);
      renderHealthChip();
      // Turno fechou: o disco já tem thinking e texto completos.
      const bst = tabs.find(x => x.key === sessionId);
      if (bst) { bst.streamText = ''; bst.thinkText = ''; }
      saveTabs();
    } else if (line.includes('thinking_delta')) {
      // Aba de fundo: o parcial acumula aqui. O .jsonl só recebe a mensagem no fim
      // do turno, então sem isto voltar para a aba não acharia nem o thinking.
      const bt = tabs.find(x => x.key === sessionId);
      if (bt) bt.thinkText = appendCapped(bt.thinkText, deltaOf(line, 'thinking_delta'), STREAM_CAP);
      setTurn(sessionId, true, 'pensando…');
    } else if (line.includes('text_delta')) {
      const bt = tabs.find(x => x.key === sessionId);
      if (bt) bt.streamText = appendCapped(bt.streamText, deltaOf(line, 'text_delta'), STREAM_CAP);
      maybeSaveTabs();
      setTurn(sessionId, true, 'respondendo…');
    }
    return;
  }

  if (line.includes('"type":"response"') && !line.includes(PREFIX)) {
    let resp = null;
    try { resp = JSON.parse(line); } catch { /* nao e resposta */ }
    if (resp && resp.command) {
      if (resp.success) handleResponse(resp);
      else {
        $('log').appendChild(el('div', 'row note', resp.command + ': falhou'));
        // O Diagnóstico virou overlay (⚙ → Debug): o buffer já guarda a falha,
        // mas nada abre sozinho por cima do que o usuário está lendo.
      }
      return;
    }
  }

  const snap = extractSnapshot(line);
  if (snap) { renderSubs(snap); return; }

  if (!line.includes('"type":"')) return;
  let rec;
  try { rec = JSON.parse(line); } catch { return; }

  switch (rec.type) {
    case 'message_start':
      if (rec.message && rec.message.role === 'assistant') {
        stream = { node: null, text: '', thinkBody: null };
        // Turno novo: o parcial guardado era do anterior (já está no disco).
        const mt = tabs.find(x => current && x.key === current.key);
        if (mt) { mt.streamText = ''; mt.thinkText = ''; }
      }
      break;

    case 'message_update': {
      const d = rec.assistantMessageEvent;
      if (!d || !d.delta) break;

      if (d.type === 'thinking_delta') {
        if (!stream) stream = { node: null, text: '', thinkBody: null };
        setTurn(current.key, true, 'pensando…');
        if (!stream.thinkBody) {
          const wrap = thinkBlock('');
          stream.thinkBody = wrap.querySelector('.think-body');
          $('log').appendChild(wrap);
        }
        stream.thinkBody.textContent += d.delta;
        // Guarda por aba: trocar de aba no meio do pensamento não perde o parcial.
        const tt = tabs.find(x => current && x.key === current.key);
        if (tt) tt.thinkText = appendCapped(tt.thinkText, d.delta, STREAM_CAP);
        scrollBottom();
        break;
      }

      if (d.type === 'text_delta') {
        if (!stream) stream = { node: null, text: '', thinkBody: null };
        setTurn(current.key, true, 'respondendo…');
        if (!stream.node) {
          const row = mdRow();
          $('log').appendChild(row.root);
          stream.node = row.body;
        }
        stream.text += d.delta;
        // Guarda por aba: trocar de aba no meio do stream não perde o parcial.
        const tt = tabs.find(x => current && x.key === current.key);
        if (tt) tt.streamText = stream.text.slice(-STREAM_CAP);
        maybeSaveTabs();
        scheduleStreamRender();
        scrollBottom();
      }
      break;
    }

    case 'tool_execution_start':
      card(rec.toolCallId, rec.toolName, rec.args, null, Date.now());
      stream = null;
      // Trecho de texto anterior já está renderizado: não reanexa na volta.
      { const tst = tabs.find(x => current && x.key === current.key); if (tst) { tst.streamText = ''; tst.thinkText = ''; } }
      if (rec.toolName === 'subagent') setStatus('subagent disparado…');
      break;

    case 'tool_execution_update': {
      const entry = cards.get(rec.toolCallId);
      if (entry) applyToolResult(entry, rec.partialResult);
      break;
    }

    case 'tool_execution_end': {
      const entry = cards.get(rec.toolCallId) || card(rec.toolCallId, rec.toolName, rec.args, null, Date.now());
      entry.root.classList.add(rec.isError ? 'err' : 'ok');
      entry.icon.textContent = rec.isError ? '✕' : '✓';
      applyToolResult(entry, rec.result);
      if (uiSettings.expandTools) entry.root.classList.remove('collapsed');
      scrollBottom();
      break;
    }

    case 'agent_settled':
      maybeNotifyDone(sessionId);
      setStatus('pronto');
      setState('ready');
      setTurn(sessionId, false);
      // Resposta completa foi para o disco: os parciais guardados caducaram.
      renderHealthChip();
      {
        const st = tabs.find(x => x.key === sessionId);
        if (st) { st.streamText = ''; st.thinkText = ''; }
        saveTabs();
      }
      if (current && current.childrenDir) loadChildren(current.childrenDir);
      // Turno pode ter editado arquivos: a aba de diffs se atualiza sozinha.
      loadGit(); loadEdits(); loadPlans();
      sendCommand({ type: 'get_session_stats' });
      break;

    case 'extension_ui_request': {
      if (rec.method === 'notify' && rec.message) {
        extActivity(rec.message, null);
      } else if (rec.method === 'setStatus' && rec.statusText) {
        extActivity(rec.statusText, rec.statusKey || 'status');
      }
      break;
    }

    case 'queue_update':
      syncQueue(sessionId, [].concat(rec.steering || [], rec.followUp || []));
      break;

    case 'auto_retry_start':
      $('log').appendChild(el('div', 'row note', 'retry ' + rec.attempt + '/' + rec.maxAttempts));
      break;

    default:
      break;
  }
});

listen('rpc-stderr', (ev) => {
  const [sessionId, line] = ev.payload;
  if (!current || sessionId !== current.key) return;
  // Aviso benigno: sessão nova criada pelo próprio app.
  if (/No project session found with id .*creating a new session/i.test(line)) return;
  $('log').appendChild(el('div', 'row note', '[stderr] ' + line));
  scrollBottom();
});

listen('rpc-exit', (ev) => {
  const key = ev.payload;
  const t = tabs.find(x => x.key === key);
  const wasWorking = !!(t && t.working);
  // Processo morreu: zera o estado da aba, senão a próxima troca manda comandos
  // para uma sessão que o Rust já não tem ("sessao '...' nao iniciada").
  liveOrder = liveOrder.filter(k => k !== key);
  if (t) t.connected = false;
  if (current && current.key === key) current.connected = false;
  setTurn(key, false);
  const dead = tabs.find(x => x.key === key);
  if (dead) for (const entry of dead.localRows || []) if (entry.state === 'queued') markRow(entry, 'cancelled');
  pendingPromptRows.clear();
  renderTabs();
  updateProcCount();
  if (current && key === current.key) {
    setStatus('processo encerrado');
    setTyping(false);
    setState('off');
    $('log').appendChild(el('div', 'row note', wasWorking
      ? 'o processo do pi encerrou no meio do turno — resposta incompleta (envie de novo para continuar)'
      : 'processo do pi encerrado'));
    scrollBottom();
  }
});

/* =============== respostas do RPC (modelo, thinking, estado) =============== */

function contextLabel(n) {
  if (!n) return '';
  if (n >= 1000000) return (Math.round(n / 100000) / 10) + 'M';
  return Math.round(n / 1000) + 'k';
}

function updateModelButton(m) {
  if (!m) return;
  $('modelname').textContent = m.name || m.id;
  $('modelctx').textContent = contextLabel(m.contextWindow);
  $('modeltoggle').title = (m.provider ? m.provider + '/' : '') + m.id;
  try { localStorage.setItem('last-model', JSON.stringify(m)); } catch { /* sem storage */ }
}

/** Catálogo instantâneo do CLI (`pi --list-models`) — não exige sessão nem RPC. */
async function warmModels() {
  try {
    const list = JSON.parse(String(await inv('pi_models')));
    if (Array.isArray(list) && list.length) fillModels(list);
  } catch { /* fica com o cache */ }
}

/** Último modelo usado, para o botão não nascer vazio. */
function loadLastModel() {
  try {
    const m = JSON.parse(localStorage.getItem('last-model') || 'null');
    if (m && m.id) updateModelButton(m);
  } catch { /* ignora */ }
}

function loadCachedLevels() {
  try {
    const cached = JSON.parse(localStorage.getItem('levels-cache') || 'null');
    if (Array.isArray(cached) && cached.length) fillLevels(cached);
  } catch { /* ignora */ }
}

function fillModels(models, currentModel) {
  if (Array.isArray(models) && models.length) {
    allModels = models;
    modelsByProvider = new Map();
    for (const m of models) {
      if (!m || !m.id) continue;
      const p = m.provider || 'outros';
      if (!modelsByProvider.has(p)) modelsByProvider.set(p, []);
      modelsByProvider.get(p).push(m);
    }
  }
  const cur = (sessionState && sessionState.model) || currentModel;
  if (cur) updateModelButton(cur);
  renderModelList($('modelsearch') ? $('modelsearch').value : '');
  try { localStorage.setItem('models-cache', JSON.stringify(models)); } catch { /* sem storage */ }
  debugNote('providers=' + modelsByProvider.size + ' models=' + allModels.length);
}

/** Pinta o seletor na hora com o último catálogo conhecido (antes do RPC responder). */
function loadCachedModels() {
  try {
    const cached = JSON.parse(localStorage.getItem('models-cache') || 'null');
    if (Array.isArray(cached) && cached.length) fillModels(cached);
  } catch { /* ignora */ }
}

function renderModelList(filter) {
  const host = $('modellist');
  if (!host) return;
  clear(host);
  const q = String(filter || '').toLowerCase();
  const curId = sessionState && sessionState.model ? sessionState.model.id : '';

  for (const provider of [...modelsByProvider.keys()].sort()) {
    const rows = modelsByProvider.get(provider)
      .filter(m => !q || (m.id + ' ' + (m.name || '')).toLowerCase().includes(q))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    if (!rows.length) continue;

    host.appendChild(el('div', 'model-group', provider.toUpperCase()));
    for (const m of rows) {
      const row = el('div', 'model-row' + (m.id === curId ? ' current' : ''));
      row.appendChild(el('span', 'model-name', m.name || m.id));
      row.appendChild(el('span', 'model-ctx', contextLabel(m.contextWindow)));
      row.onclick = () => applyModel(m);
      host.appendChild(row);
    }
  }
  if (!host.childElementCount) host.appendChild(el('div', 'model-empty', 'nenhum modelo'));
}

function fillLevels(levels) {
  if (Array.isArray(levels)) levelList = levels;
  const btn = $('thinkbtn');
  const foot = $('thinkfoot');
  const slider = $('thinkslider');
  const name = $('thinkname');
  if (!btn || !foot || !slider || !name) return;
  if (!levelList.length) {
    btn.textContent = 'thinking';
    foot.classList.add('hidden');
    return;
  }

  const cur = sessionState && sessionState.thinkingLevel;
  const at = Math.max(0, levelList.indexOf(cur));
  btn.textContent = levelList[at];
  btn.title = 'thinking: ' + levelList[at] + ' — clique para escolher';
  // Modelo sem reasoning devolve só ["off"]: sem slider.
  if (levelList.length <= 1) { foot.classList.add('hidden'); return; }
  foot.classList.remove('hidden');
  slider.min = '0';
  slider.max = String(levelList.length - 1);
  slider.value = String(at);
  name.textContent = levelList[at];
  debugNote('levels=' + levelList.length + ' selected=' + cur);
}

function fmtTokens(n) {
  if (n == null) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace('.0', '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.0', '') + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(n);
}

/** Detalhamento do contexto (mesmo formato que o pi-gpui mostra). */
function fmtCost(c) { return typeof c === 'number' ? 'US$ ' + c.toFixed(2) : '—'; }
function sessShort(t) { return t.label || prettyId(t.key); }
function renderCtxPop() {
  const host = $('ctxrows');
  const st = (sessionState && sessionState.stats) || null;
  if (!st || !st.tokens) {
    // Sem stats da sessão atual: ainda mostra o agregado das abas que já têm.
    clear(host);
    renderSessAggregate(host, null);
    if (!host.childElementCount) setEmpty(host, 'sem estatísticas ainda');
    return;
  }

  const cu = st.contextUsage || {};
  const t = st.tokens || {};
  clear(host);

  const row = (k, v, dim) => {
    const r = el('div', 'ctx-row');
    r.appendChild(el('div', 'k', k));
    r.appendChild(el('div', 'v' + (dim ? ' dim' : ''), v));
    host.appendChild(r);
  };

  row('Context window',
    (cu.percent != null ? Math.round(cu.percent) + '% usado · ' : '') +
    fmtTokens(cu.tokens) + ' / ' + fmtTokens(cu.contextWindow) + ' tokens');
  // Alerta por % do contexto: mesmo limiar do chip (70/90).
  if (cu.percent != null && Math.round(cu.percent) >= 70) {
    const pct = Math.round(cu.percent);
    host.appendChild(el('div', 'ctx-alert ' + (pct >= 90 ? 'danger' : 'warn'),
      pct >= 90
        ? 'Contexto quase cheio (' + pct + '%) — rode /compact agora'
        : 'Contexto em ' + pct + '% — considere /compact'));
  }
  row('Auto-compactação', sessionState && sessionState.autoCompactionEnabled ? 'ligada' : 'desligada', true);
  const limRow = el('div', 'ctx-row');
  limRow.appendChild(el('div', 'k', 'Compactar em'));
  limRow.appendChild(renderLimitSelect(cu.contextWindow || ctxWindow()));
  host.appendChild(limRow);
  row('Prompt cache (sessão)',
    'read ' + fmtTokens(t.cacheRead) + ' · write ' + fmtTokens(t.cacheWrite), true);
  row('Input / Output', fmtTokens(t.input) + ' / ' + fmtTokens(t.output));
  row('Custo', fmtCost(st.cost));
  row('Mensagens', String(st.totalMessages || 0), true);
  renderSessAggregate(host, current && current.key);
}

/** Agregado tokens/custo por sessão a partir do cache em tabs[] (sem RPC novo). */
function renderSessAggregate(host, curKey) {
  const rows = tabs.filter(x => x.stats && x.stats.tokens);
  if (!rows.length) return;
  let totTok = 0, totCost = 0, totMsg = 0;
  for (const x of rows) {
    totTok += Number(x.stats.tokens && x.stats.tokens.total) || 0;
    if (typeof x.stats.cost === 'number') totCost += x.stats.cost;
    totMsg += Number(x.stats.totalMessages) || 0;
  }
  const tot = el('div', 'ctx-total');
  tot.appendChild(el('span', null, rows.length + (rows.length === 1 ? ' sessão' : ' sessões')));
  tot.appendChild(el('span', null, fmtTokens(totTok) + ' · ' + fmtCost(totCost) + ' · ' + totMsg + ' msg'));
  host.appendChild(tot);
  const ordered = rows.slice().sort((a, b) => {
    const pa = (a.stats.contextUsage && a.stats.contextUsage.percent) || 0;
    const pb = (b.stats.contextUsage && b.stats.contextUsage.percent) || 0;
    return pb - pa;
  });
  for (const x of ordered.slice(0, 8)) {
    const p = x.stats.contextUsage && x.stats.contextUsage.percent != null
      ? Math.round(x.stats.contextUsage.percent) : null;
    const r = el('div', 'ctx-sess');
    r.appendChild(el('span', 'n', (x.key === curKey ? '● ' : '') + sessShort(x)));
    r.appendChild(el('span', 'm' + (p == null ? '' : ' ' + (p >= 90 ? 'danger' : p >= 70 ? 'warn' : '')),
      (p == null ? '—' : p + '%') + ' · ' + fmtTokens(x.stats.tokens.total) + ' · ' + fmtCost(x.stats.cost)));
    r.title = x.key;
    host.appendChild(r);
  }
}

function updateStats(data) {
  if (current) {
    sessionState = { ...(sessionState || {}), stats: data || {} };
    // Cache por sessão: o popover agrega tokens/custo sem pedir nada novo ao RPC.
    const tb = tabs.find(x => x.key === current.key);
    if (tb) tb.stats = data || {};
  }
  const cu = data && data.contextUsage;
  const btn = $('ctxbtn');
  if (!cu || cu.percent == null) {
    btn.textContent = '—';
    btn.title = 'contexto indisponível';
    btn.classList.remove('warn', 'danger');
    if (!$('ctxpop').classList.contains('hidden')) renderCtxPop();
    return;
  }
  const pct = Math.round(cu.percent);
  btn.textContent = pct + '% · ' + fmtTokens(cu.tokens) + '/' + fmtTokens(cu.contextWindow);
  btn.title = cu.tokens + ' / ' + cu.contextWindow + ' tokens (' + pct + '%) — clique para detalhes';
  btn.classList.toggle('warn', pct >= 70 && pct < 90);
  btn.classList.toggle('danger', pct >= 90);
  if (data && typeof data.autoCompactionEnabled === 'boolean') {
    sessionState = { ...(sessionState || {}), autoCompactionEnabled: data.autoCompactionEnabled, stats: data };
    $('autocompact').classList.toggle('on', data.autoCompactionEnabled);
  }
  if (!$('ctxpop').classList.contains('hidden')) renderCtxPop();
}

function closeModelPop() { $('modelpop').classList.add('hidden'); }

/* =============== desfazer fila / fork (criação) ===============
   Desfazer fila manda só `clear_queue` (docs/rpc-commands.md): o pi devolve
   {steering[], followUp[]} e o handler `clear_queue` existente restaura a última
   no composer. Sem `abort`: o turno continua.
   Fork cria sessão nova (runtimeHost.fork + rebindSession no pi): a original é
   preservada. Não rotular como desfazer — é criação. */
let pendingForkReload = false;
let pendingForkAnchor = null;

function normForkText(s) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 120); }

function forkRowBtn(anchor, title) {
  const btn = el('button', 'tiny forkrow', 'fork');
  btn.title = title;
  btn.onclick = (e) => { e.stopPropagation(); forkFromAnchor(anchor); };
  return btn;
}

/** Fork a partir de uma linha: resolve o entryId via get_fork_messages (ordem + texto).
    Cai para o picker (openForkPop) quando não há match exato — nunca chuta entryId. */
function forkFromAnchor(anchor) {
  if (!current) return note('sem sessão aberta');
  if (!current.connected) return note('sessão somente leitura — conecte para forkar');
  pendingForkAnchor = { uindex: anchor.uindex, utext: anchor.utext, key: current.key };
  sendCommand({ type: 'get_fork_messages' });
}

function resolveForkAnchor(msgs) {
  const a = pendingForkAnchor;
  pendingForkAnchor = null;
  if (!a || !current || current.key !== a.key) return false;
  const items = (msgs || []).filter(m => m && m.entryId);
  if (!items.length) return false;
  const want = normForkText(a.utext);
  let hit = null;
  if (want) {
    if (items[a.uindex] && normForkText(items[a.uindex].text) === want) hit = items[a.uindex];
    else hit = items.find(m => normForkText(m.text) === want) || null;
  } else if (items[a.uindex]) hit = items[a.uindex];
  if (!hit) return false;
  sendCommand({ type: 'fork', entryId: hit.entryId });
  return true;
}

/** Envia `clear_queue` sem `abort`: a fila volta ao composer, o turno continua. */
async function desfazerFila() {
  if (!current) return note('sem sessão aberta');
  if (!current.connected && !(await ensureRpc())) return;
  const t = tabs.find(x => current && x.key === current.key);
  const empty = !(t && t.queue && t.queue.length) && !localRows(t).some(e => e.state === 'queued');
  if (empty) return note('nada na fila para desfazer');
  sendCommand({ type: 'clear_queue' });
}

function closeForkPop() { $('forkpop').classList.add('hidden'); }

function openForkPop(messages) {
  closeModelPop();
  const host = $('forklist');
  clear(host);
  const items = (messages || []).filter(m => m && m.entryId);
  if (!items.length) { host.appendChild(el('div', 'model-empty', 'nada para fork')); $('forkpop').classList.remove('hidden'); return; }
  for (const m of items) {
    const row = el('div', 'model-row');
    const label = String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, 120) || '(sem texto)';
    row.appendChild(el('span', 'model-name', label));
    row.appendChild(el('span', 'model-ctx', String(m.entryId).slice(0, 8)));
    row.title = (m.text || '') + '\nfork cria uma sessão nova — a original é preservada';
    row.onclick = () => { closeForkPop(); sendCommand({ type: 'fork', entryId: m.entryId }); };
    host.appendChild(row);
  }
  $('forkpop').classList.remove('hidden');
}

/* =============== limite de contexto para compactar ===============
   O pi só entende `compaction.reserveTokens` (folga abaixo do limite) e lê o
   settings.json na criação da sessão: gravar aqui vale no próximo reinício (↻).
   Nada é gravado enquanto o usuário não escolher — o padrão é o do próprio pi. */
const LIMIT_PRESETS = [70, 75, 80, 85, 90, 95];

function ctxWindow() {
  const cu = sessionState && sessionState.stats && sessionState.stats.contextUsage;
  const m = sessionState && sessionState.model;
  return (cu && cu.contextWindow) || (m && m.contextWindow) || 0;
}

function renderLimitSelect(win) {
  const sel = document.createElement('select');
  sel.id = 'ctxlimit';
  sel.className = 'ctx-sel';
  sel.title = 'Em que ponto do contexto o pi compacta. Vale ao reiniciar o pi (↻).';
  const opt = (v, label) => {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    sel.appendChild(o);
  };
  opt('', 'padrão do pi');
  let matched = '';
  for (const p of LIMIT_PRESETS) {
    const reserve = win ? Math.round(win * (100 - p) / 100) : 0;
    opt(String(p), p + '%' + (reserve ? ' · reserva ' + fmtTokens(reserve) : ''));
    if (compactReserve != null && reserve &&
        Math.abs(compactReserve - reserve) <= Math.max(1, win * 0.004)) matched = String(p);
  }
  if (compactReserve != null && !matched) opt('custom', 'custom · reserva ' + fmtTokens(compactReserve));
  sel.value = compactReserve == null ? '' : (matched || 'custom');
  sel.disabled = !(sessionState && sessionState.model && current) || !(win > 0);
  sel.onchange = () => saveLimit(sel, win);
  return sel;
}

async function saveLimit(sel, win) {
  const model = sessionState && sessionState.model;
  if (!current || !model || !(win > 0) || sel.value === 'custom') return;
  const pct = sel.value === '' ? null : Number(sel.value);
  const reserve = pct == null ? null : Math.max(0, Math.round(win * (100 - pct) / 100));
  sel.disabled = true;
  try {
    const raw = await inv('compaction_set', {
      cwd: current.cwd,
      provider: model.provider,
      model: model.id,
      reserveTokens: reserve,
    });
    const st = JSON.parse(String(raw));
    compactReserve = typeof st.reserveTokens === 'number' ? st.reserveTokens : null;
    note(pct == null
      ? 'compactação: padrão do pi (aplica ao reiniciar ↻)'
      : 'compactação em ' + pct + '% do contexto · reserva ' + fmtTokens(compactReserve) + ' (aplica ao reiniciar ↻)');
  } catch (e) {
    note('falha ao salvar o limite de compactação: ' + e);
  }
  renderCtxPop();
}

async function refreshCompactLimit() {
  const model = sessionState && sessionState.model;
  if (!current || !model) { compactReserve = null; return; }
  try {
    const raw = await inv('compaction_get', {
      cwd: current.cwd,
      provider: model.provider,
      model: model.id,
    });
    const st = JSON.parse(String(raw));
    compactReserve = typeof st.reserveTokens === 'number' ? st.reserveTokens : null;
  } catch {
    compactReserve = null;
  }
  if (!$('ctxpop').classList.contains('hidden')) renderCtxPop();
}

function handleResponse(rec) {
  const data = rec.data || {};
  // Diagnóstico: latência do comando (só registra; o switch abaixo não muda).
  try {
    const t0 = diagPending.get(rec.id);
    if (t0 != null) diagPending.delete(rec.id);
    diagPush('\u2190 ' + (rec.command || '?'), t0 == null ? '—' : (Date.now() - t0) + 'ms', rec.success ? 'ok' : 'falhou');
  } catch { /* diagnóstico nunca quebra resposta */ }
  switch (rec.command) {
    case 'prompt': {
      // disposition: started | queued | handled. Só "queued" ganha a marca de fila.
      const entry = pendingPromptRows.get(rec.id);
      if (entry) {
        pendingPromptRows.delete(rec.id);
        if (data.disposition === 'queued') markRow(entry, 'queued');
      }
      break;
    }
    case 'clear_queue': {
      // Devolve o que estava enfileirado: a última volta para o composer.
      const back = [].concat(data.steering || [], data.followUp || []);
      const ct = tabs.find(x => current && x.key === current.key);
      if (ct) {
        ct.queue = [];
        for (const entry of ct.localRows || []) if (entry.state === 'queued') markRow(entry, 'cancelled');
      }
      if (!back.length) break;
      note('fila devolvida: ' + back.length + ' mensagem(ns)');
      const last = back.at(-1);
      $('input').value = last;
      autosizeInput();
      const t = tabs.find(x => x.key === current.key);
      if (t) t.draft = last;
      break;
    }
    case 'get_fork_messages': {
      // Lista para fork (getUserMessagesForForking no pi): mensagens do usuário
      // forkáveis com entryId. Escolher cria sessão nova (case 'fork').
      const msgs = (data && data.messages) || [];
      // Vinda de botão por linha: tenta resolver direto; sem match, cai no picker.
      if (pendingForkAnchor) {
        const akey = pendingForkAnchor.key;
        if (!current || current.key !== akey) { pendingForkAnchor = null; break; }
        if (resolveForkAnchor(msgs)) break;
        note('não localizei a mensagem para fork — escolha na lista');
      }
      if (!msgs.length) { note('nada para fork: sem mensagens do usuário nesta sessão'); break; }
      openForkPop(msgs);
      break;
    }
    case 'fork': {
      // Criação, não desfazer: o pi troca o RPC para o arquivo novo (rebindSession)
      // e a original continua no disco. Posição "before": o texto volta ao composer.
      if (rec.success === false) { note('fork falhou'); break; }
      if (data.cancelled) { note('fork cancelado'); break; }
      const ft = data.text || '';
      if (ft) {
        $('input').value = ft;
        autosizeInput();
        const ft0 = tabs.find(x => current && x.key === current.key);
        if (ft0) ft0.draft = ft;
      }
      note('fork criado em nova sessão — a original foi preservada' + (ft ? ' (texto restaurado no composer)' : ''));
      pendingForkReload = true;
      sendCommand({ type: 'get_state' });
      break;
    }
    case 'get_messages':
      // Não deixa uma resposta vazia do RPC apagar o histórico já renderizado do disco.
      if (Array.isArray(data.messages) && data.messages.length) renderMessages(data);
      break;
    case 'get_state':
      sessionState = data;
      if (current) { const tb = tabs.find(x => x.key === current.key); if (tb) { if (data.model) tb.model = data.model; if (data.thinkingLevel) tb.thinkingLevel = data.thinkingLevel; } }
      // Thinking é por sessão/modelo: pede a lista certa sempre, não só após set_model.
      sendCommand({ type: 'get_available_thinking_levels' });
      if (data.model) updateModelButton(data.model);
      // Arquivo real da sessão: sessão nova só ganha `.jsonl` na 1ª mensagem.
      if (data.sessionFile) {
        const dir = data.sessionFile.replace(/\.jsonl$/, '');
        if (activeTab) { activeTab.file = data.sessionFile; activeTab.childrenDir = dir; }
        if (current) { current.file = data.sessionFile; current.childrenDir = dir; }
        // Sessão criada com `+ Nova` nasce sem childrenDir: sem isto o painel de
        // subagents fica sem origem e nunca lista nada até reabrir pela sidebar.
        if (current) loadChildren(dir);
        loadGit(); loadEdits(); loadPlans();
        // Pós-fork: abre a sessão nova resultante (histórico + sidebar).
        if (pendingForkReload) {
          pendingForkReload = false;
          loadSessions();
          loadHistoryFromDisk(data.sessionFile);
        }
      }
      fillLevels(null);
      $('autocompact').classList.toggle('on', data.autoCompactionEnabled !== false);
      break;
    case 'get_session_stats':
      updateStats(data);
      // Só narra no transcript quando o usuário pediu (/session ou chip de contexto).
      if (statsNoteRequested && data && data.tokens) {
        statsNoteRequested = false;
        const c = typeof data.cost === 'number' ? ' · US$ ' + data.cost.toFixed(2) : '';
        $('log').appendChild(el('div', 'row note',
          'sessão: ' + data.totalMessages + ' mensagens · ' + data.tokens.total + ' tokens' + c));
      }
      break;
    case 'get_last_assistant_text': {
      const text = (data && (data.text || data.content)) || '';
      if (!text) { $('log').appendChild(el('div', 'row note', 'nenhuma resposta para copiar')); break; }
      inv('copy_text', { text })
        .then(() => $('log').appendChild(el('div', 'row note', 'resposta copiada (' + text.length + ' caracteres)')))
        .catch((e) => $('log').appendChild(el('div', 'row note', 'falha ao copiar: ' + e)));
      break;
    }
    case 'cycle_thinking_level':
      $('log').appendChild(el('div', 'row note',
        data && data.level ? 'thinking: ' + data.level : 'modelo sem níveis de thinking'));
      if (data && data.level) {
        sessionState = { ...(sessionState || {}), thinkingLevel: data.level };
        if (current) { const tb = tabs.find(x => x.key === current.key); if (tb) tb.thinkingLevel = data.level; }
        fillLevels(null);
      }
      break;
    case 'set_model':
      // Níveis de thinking são por modelo (xhigh/max só existem em alguns): sem isto
      // a lista continuava sendo a do modelo anterior e o xhigh nunca aparecia.
      if (rec.success) {
        sendCommand({ type: 'get_available_thinking_levels' });
        sendCommand({ type: 'get_state' });
      } else {
        $('log').appendChild(el('div', 'row note', 'set_model: falhou'));
      }
      break;
    case 'compact':
      endCompact(rec.success ? 'contexto compactado' : 'falha ao compactar');
      break;
    case 'export_html':
      $('log').appendChild(el('div', 'row note', 'exportado: ' + ((data && (data.path || data.outputPath)) || 'ok')));
      break;
    case 'set_session_name':
      $('log').appendChild(el('div', 'row note', 'sessão renomeada'));
      break;
    case 'abort':
      $('log').appendChild(el('div', 'row note', 'turno interrompido'));
      setStatus('pronto');
      setTurn(current && current.key, false);
      setState('ready');
      break;
    default:
      // Nenhum comando pode ser silencioso: se não há handler específico, registra o resultado.
      if (rec.command) {
        $('log').appendChild(el('div', 'row note',
          rec.command + ': ' + (rec.success ? 'ok' : 'falhou')));
      }
      break;
    case 'get_available_models':
      fillModels(data.models || [], !allModels.length ? data.models && data.models[0] : null);
      break;
    case 'get_available_thinking_levels':
      fillLevels(data.levels || []);
      if (current) { const tb = tabs.find(x => x.key === current.key); if (tb) tb.levelList = (data.levels || []).slice(); }
      break;
    case 'get_commands':
      saveCommands(data.commands || []);
      checkCommands(data.commands || []);
      renderPalette();
      break;
  }
}

function sendCommand(payload) {
  if (!current) { note('sem sessão aberta'); return; }
  payload.id = 'ui-' + (++seq);
  // Diagnóstico: marca o envio para medir a latência na resposta.
  try { diagPending.set(payload.id, Date.now()); diagPush('\u2192 ' + (payload.type || '?'), '—', payload.id); } catch { /* ignora */ }
  inv('rpc_command', { sessionId: current.key, payload: JSON.stringify(payload) })
    .catch((e) => {
      note('falha ao enviar ' + (payload.type || 'comando') + ': ' + e);
      if (payload.type === 'compact') resetCompact();
    });
}

/* =============== detalhe do subagent =============== */
function parseSessionFile(raw) {
  const messages = [];
  let meta = null;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec = null;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec) continue;
    if (rec.type === '__deck_meta') { meta = rec; continue; }
    if (rec.type === 'message' && rec.message) messages.push(rec.message);
  }
  return { messages, meta };
}

let loadedConsumed = 0;

/** Zera a paginação da view (contador + barra) em toda troca de sessão. */
function resetPaged() {
  loadedConsumed = 0;
  const bar = $('loadmore');
  if (bar) bar.classList.add('hidden');
}

/** Arquivos editados são da sessão: a lista não sobrevive à troca. */
function resetFiles() {
  editedFiles = [];
}

function updateLoadMore(meta) {
  const bar = $('loadmore');
  if (!meta || !meta.hasMore) {
    bar.classList.add('hidden');
    return;
  }
  loadedConsumed = meta.consumed || messages0(meta);
  const left = Math.max(0, (meta.total || 0) - loadedConsumed);
  $('loadmorebtn').textContent = 'carregar anteriores (' + left + ' de ' + (meta.total || 0) + ')';
  bar.classList.remove('hidden');
}

function messages0(meta) {
  return (meta.total || 0) - (meta.omitted || 0) - (meta.oversized || 0);
}

async function loadEarlier() {
  const file = current && current.file;
  if (!file) return;
  const seq = viewSeq;
  const btn = $('loadmorebtn');
  btn.disabled = true;
  btn.textContent = 'carregando…';
  try {
    const raw = await inv('read_session_messages', { path: file, limit: 250, skip: loadedConsumed });
    if (seq !== viewSeq) return; // trocou de sessão: não insere no log novo
    const { messages, meta } = parseSessionFile(raw);
    if (!messages.length) { updateLoadMore(meta); return; }

    const tmp = document.createElement('div');
    renderMessages({ messages }, { target: tmp, store: new Map() }, false);

    const log = $('log');
    const beforeHeight = log.scrollHeight;
    const anchor = log.firstChild;
    for (const node of Array.from(tmp.childNodes)) log.insertBefore(node, anchor);
    log.scrollTop += log.scrollHeight - beforeHeight;

    updateLoadMore(meta);
    updateScrollBtn();
  } catch (e) {
    if (seq !== viewSeq) return; // erro da sessão anterior não aparece na nova
    $('log').appendChild(el('div', 'row note', String(e)));
  } finally {
    btn.disabled = false;
  }
}

async function loadHistoryFromDisk(file) {
  const seq = viewSeq;
  try {
    loadedConsumed = 0;
    const raw = await inv('read_session_messages', { path: file, limit: 250 });
    // Troquei de sessão durante a leitura: este histórico não é mais da view.
    if (seq !== viewSeq) return;
    const { messages, meta } = parseSessionFile(raw);
    if (messages.length) renderMessages({ messages }, null, true);
    updateLoadMore(meta);
    if (current && !messages.length) setEmptyState(true, 'newsession');
  } catch { /* o RPC ainda pode preencher */ }
}

async function openChild(c) {
  if (!c || !c.file) return;
  const seq = viewSeq;
  const host = $('detaillog');
  setEmpty(host, 'carregando transcript…');
  $('detailtitle').textContent = (c.label || c.id.slice(0, 8)) + '  ·  ' + c.run;
  $('detail').classList.remove('hidden');

  try {
    const raw = await inv('read_session_messages', { path: c.file });
    if (seq !== viewSeq) return;
    const { messages } = parseSessionFile(raw);
    if (!messages.length) {
      setEmpty(host, 'transcript vazio (arquivo sem mensagens)');
      return;
    }
    renderMessages({ messages }, { target: host, store: new Map() }, false);
  } catch (e) {
    if (seq !== viewSeq) return;
    setEmpty(host, String(e));
  }
}

function closeDetail() { $('detail').classList.add('hidden'); }

/* =============== recarregar o pi (sem comando RPC: reinicia processo) =============== */
async function reloadSession() {
  if (!current) return;
  const { key, cwd, childrenDir, refValue, refFlag } = current;
  setStatus('recarregando…');
  try { await inv('stop_session', { sessionId: key }); } catch { /* já parado */ }
  current = null;
  sessionState = null;
  allModels = [];
  await start(cwd, key, refValue, refFlag, childrenDir);
}

/* =============== abas =============== */
/** Altura do composer acompanha o texto (digitação e colagem), com teto de 40% da
    viewport: colar um log enorme não pode engolir o transcript. Mesmo teto do CSS
    (`max-height:40vh`), que fica só como rede de segurança. */
function autosizeInput() {
  const box = $('input');
  if (!box) return;
  box.style.height = 'auto';
  const max = Math.min(Math.round(window.innerHeight * 0.40), 400);
  box.style.height = Math.min(box.scrollHeight, max) + 'px';
}

/** O composer é da aba: guarda o rascunho (texto + imagens) antes de sair. */
function stashDraft() {
  const t = current && tabs.find(x => x.key === current.key);
  if (!t) return;
  t.draft = $('input').value;
  t.images = pendingImages.slice();
  // Resposta parcial em andamento: guarda por aba para reanexar ao voltar.
  if (stream && stream.text) t.streamText = String(stream.text).slice(-STREAM_CAP);
  saveTabs();
}

/** Restaura o rascunho da aba que entrou em foco (vazio para aba nova). */
function restoreDraft(t) {
  $('input').value = (t && t.draft) || '';
  // No próximo tick: a aba acabou de entrar em foco e o painel ainda está sendo
  // medido — `scrollHeight` de um elemento recém-exibido viria 0.
  setTimeout(autosizeInput, 0);
  pendingImages = (t && Array.isArray(t.images) ? t.images : []).slice();
  renderAttachments();
  hidePalette();
}

/** Estado da aba: turno rodando manda mais que a conexão. */
function tabState(t) {
  if (t.working) return { label: 'running', dot: ' busy' };
  if (t.connected) return { label: 'conectado', dot: ' live' };
  return { label: 'somente leitura', dot: '' };
}

function renderTabs() {
  const host = $('tabs');
  if (!host) return;
  clear(host);
  for (const t of tabs) {
    const active = activeTab && t.key === activeTab.key;
    const st = tabState(t);
    const tab = el('div', 'tab' + (active ? ' active' : ''));
    tab.title = projectName(t.cwd) + '\n' + (t.cwd || '—') + '\n' + t.key + '\n' + st.label;
    tab.appendChild(el('span', 'tab-dot' + st.dot));
    tab.appendChild(el('span', 'tab-proj', projectName(t.cwd)));
    tab.appendChild(el('span', 'tab-title', t.label || prettyId(t.key)));
    const x = el('button', 'tab-close', '✕');
    x.onclick = (e) => { e.stopPropagation(); closeTab(t.key); };
    tab.appendChild(x);
    tab.onclick = () => switchTab(t.key);
    host.appendChild(tab);
  }
  // Toda mutação de aba passa por aqui: persiste sem RPC novo.
  saveTabs();
}

async function switchTab(key) {
  const t = tabs.find(x => x.key === key);
  if (!t || (current && current.key === key)) return;

  stashDraft();
  viewSeq++;
  resetPaged();
  current = { key: t.key, cwd: t.cwd, childrenDir: t.childrenDir, refValue: t.refValue, refFlag: t.refFlag, file: t.file, connected: !!t.connected };
  reconcileTerminal();
  activeTab = t;
  cards.clear();
  // pendingPromptRows NÃO é limpo aqui: a resposta do prompt pode chegar depois da
  // troca de aba e ainda precisa marcar a linha como "na fila".
  lastSnap = null;
  lastDiskList = null;
  resetFiles();
  stream = null;
  sessionState = null;
  // Troca de sessão: nunca pinta a lista de thinking da sessão anterior.
  levelList = [];
  fillLevels([]);
  if (Array.isArray(t.levelList) && t.levelList.length) fillLevels(t.levelList.slice());
  if (t.model) { sessionState = { model: t.model, thinkingLevel: t.thinkingLevel || null }; updateModelButton(t.model); }
  // Chip de contexto é por sessão: repinta do cache e o get_session_stats abaixo atualiza.
  if (t.stats) { sessionState = { ...(sessionState || {}), stats: t.stats }; updateStats(t.stats); }
  clear($('log'));
  // O restore NÃO roda aqui: com o log recém-limpo o `seen` está vazio e tudo
  // voltaria para o fim. `renderMessages` já o chama depois de pintar (o caminho do
  // disco e o do `get_messages` passam por lá); a chamada abaixo cobre a aba sem
  // histórico, e é inofensiva se um render chegar depois — ele limpa e repinta.
  renderTabs();
  setStatus(t.connected ? 'conectado · ' + prettyId(t.key) : 'somente leitura');
  setState(t.connected ? 'ready' : 'off');
  applyTurnUi();
  restoreDraft(t);

  if (t.file) await loadHistoryFromDisk(t.file);
  restoreLocalRows();
  // Sempre confirma o processo antes de falar com ele (a flag `connected` pode estar
  // velha após exit/evicção). ensureRpc devolve true na hora se já está vivo.
  if (await ensureRpc()) {
    sendCommand({ type: 'get_messages' });
    sendCommand({ type: 'get_state' });
    sendCommand({ type: 'get_session_stats' });
  }
  if (t.childrenDir) await loadChildren(t.childrenDir);
  loadGit(); loadEdits(); loadPlans();
}

async function closeTab(key) {
  try { await inv('stop_session', { sessionId: key }); } catch { /* já parado */ }
  stopLive(key);
  // Aba fechada leva os avisos junto: reabrir a mesma key não pode herdar chip velho.
  healthBySession.delete(key);
  // Aba fechada sai do vigia: sem isto uma sonda pendente poderia destravar a chave
  // reaberta logo depois (mesma key, outro processo).
  delete lastProbeAt[key];
  const wasActive = current && current.key === key;
  tabs = tabs.filter(t => t.key !== key);

  if (wasActive) {
    // Geração nova: leitura em voo da aba fechada não pode pintar na view vazia.
    viewSeq++;
    current = null;
    activeTab = null;
    cards.clear();
    pendingPromptRows.clear();
    lastSnap = null;
    lastDiskList = null;
    resetPaged();
    resetFiles();
    clear($('log'));
    const next = tabs[tabs.length - 1];
    renderTabs();
    if (next) await switchTab(next.key);
    else { setStatus('desconectado'); setTyping(false); renderHealthChip(); }
    return;
  }
  renderTabs();
}

/* =============== persistência de abas/stream (só localStorage) =============== */
const TABS_KEY = 'tabs-v1';
const DRAFT_CAP = 10000;
const STREAM_CAP = 30000;
let lastTabsSave = 0;

/** Serializa as abas (só dados: sem DOM, sem imagens, sem flags vivas). */
function saveTabs() {
  try {
    const slim = tabs.map(t => ({
      key: t.key, cwd: t.cwd || null, childrenDir: t.childrenDir || null,
      refValue: t.refValue || null, refFlag: t.refFlag || '--session',
      file: t.file || null, label: t.label || '',
      draft: String(t.draft || '').slice(-DRAFT_CAP),
      streamText: String(t.streamText || '').slice(-STREAM_CAP),
      model: t.model || null, thinkingLevel: t.thinkingLevel || null,
      levelList: Array.isArray(t.levelList) ? t.levelList.slice(0, 50) : [],
      stats: t.stats || null,
      queue: Array.isArray(t.queue) ? t.queue.slice(0, 20) : [],
    }));
    const activeKey = activeTab ? activeTab.key : (current ? current.key : null);
    localStorage.setItem(TABS_KEY, JSON.stringify({ tabs: slim, activeKey }));
    lastTabsSave = Date.now();
  } catch { /* quota ou webview sem storage: a sessão segue em memória */ }
}

/** Economiza escrita durante o stream: persiste no máximo a cada 3s. */
function maybeSaveTabs() {
  if (Date.now() - lastTabsSave > 3000) saveTabs();
}

/** Restaura as abas como somente leitura: nada conecta aqui, o foco reconecta via ensureRpc. */
function restoreTabs() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(TABS_KEY) || 'null'); } catch { raw = null; }
  const list = raw && Array.isArray(raw.tabs) ? raw.tabs : [];
  tabs = list
    .filter(t => t && typeof t.key === 'string' && t.key)
    .map(t => ({
      key: t.key, cwd: t.cwd || null, childrenDir: t.childrenDir || null,
      refValue: t.refValue || null, refFlag: t.refFlag || '--session',
      file: t.file || null, label: t.label || '', draft: t.draft || '',
      images: [], streamText: t.streamText || '', thinkText: '',
      model: t.model || null, thinkingLevel: t.thinkingLevel || null,
      levelList: Array.isArray(t.levelList) ? t.levelList : [],
      stats: t.stats || null, queue: Array.isArray(t.queue) ? t.queue : [],
      connected: false, working: false, phase: '',
    }));
  const key = raw && raw.activeKey;
  activeTab = tabs.find(t => t.key === key) || null;
  renderTabs();
}

/** true se o log já mostra esse thinking: o disco trouxe e o parcial seria duplicata. */
function logHasThinking(text) {
  const head = String(text || '').trim().slice(0, 120);
  if (!head) return false;
  return Array.from($('log').querySelectorAll('.think-body'))
    .some(n => String(n.textContent || '').trim().startsWith(head));
}

/** Reanexa o parcial da aba ao voltar (o histórico do disco não o tem). */
function reattachStream() {
  if (stream || !current) return;
  const t = tabs.find(x => x.key === current.key);
  if (!t) return;
  // Thinking do turno em voo: `renderMessages` acima só pintou o que está no disco.
  let thinkBody = null;
  if (t.thinkText && !logHasThinking(t.thinkText)) {
    const wrap = thinkBlock(t.thinkText);
    $('log').appendChild(wrap);
    thinkBody = wrap.querySelector('.think-body');
  }
  if (!t.streamText) {
    // Só thinking até agora: ancora `stream` nele para o próximo delta continuar
    // no mesmo bloco em vez de abrir um segundo.
    if (thinkBody) stream = { node: null, text: '', thinkBody };
    return;
  }
  const row = mdRow();
  setMarkdown(row.body, t.streamText);
  $('log').appendChild(row.root);
  stream = { node: row.body, text: t.streamText, thinkBody };
  scrollBottom(true);
}

/* =============== comandos do app (não vão para o modelo) =============== */

/** Interrompe o turno atual (comando `/abort` e Esc).
 *  Esvazia a fila antes: o `abort` do pi continua mensagens enfileiradas
 *  (docs/rpc-commands.md §clear_queue), então sem isto o turno seguinte começaria sozinho. */
function abortTurn() {
  sendCommand({ type: 'clear_queue' });
  sendCommand({ type: 'abort' });
}

const APP_COMMANDS = [
  { name: 'compact', description: 'Compactar o histórico (opcional: instruções)', app: true, needsRpc: true,
    run: (a) => sendCommand(a ? { type: 'compact', customInstructions: a } : { type: 'compact' }) },
  { name: 'model', description: 'Escolher o modelo: /model [busca]', app: true,
    run: (a) => runModelArg(a) },
  { name: 'thinking', description: 'Ciclar o nível de thinking', app: true, needsRpc: true,
    run: () => sendCommand({ type: 'cycle_thinking_level' }) },
  { name: 'new', description: 'Nova sessão nesta pasta', app: true,
    run: () => newSessionIn(current ? current.cwd : (homeDir || '/')) },
  { name: 'name', description: 'Renomear a sessão: /name <nome>', app: true, needsRpc: true,
    run: (a) => {
      if (!a) return note('uso: /name <nome>');
      const t = tabs.find(x => current && x.key === current.key);
      if (t) { t.label = a; renderTabs(); }
      sendCommand({ type: 'set_session_name', name: a });
    } },
  { name: 'session', description: 'Info da sessão (tokens e custo)', app: true, needsRpc: true,
    run: () => { statsNoteRequested = true; sendCommand({ type: 'get_session_stats' }); } },
  { name: 'copy', description: 'Copiar a última resposta', app: true, needsRpc: true,
    run: () => sendCommand({ type: 'get_last_assistant_text' }) },
  { name: 'export', description: 'Exportar a sessão em HTML', app: true, needsRpc: true,
    run: () => sendCommand({ type: 'export_html' }) },
  { name: 'abort', description: 'Interromper o turno atual', app: true, needsRpc: true,
    run: abortTurn },
  { name: 'desfazer', description: 'Devolver a fila ao composer (sem interromper o turno)', app: true, needsRpc: true,
    run: () => desfazerFila() },
  { name: 'fork', description: 'Criar fork (nova sessão) de mensagem anterior — a original é preservada', app: true, needsRpc: true,
    run: () => sendCommand({ type: 'get_fork_messages' }) },
  { name: 'login', description: 'Escolher provedor e logar: /login [provider]', app: true,
    run: (a) => (a ? startLogin(a) : openProvPicker()) },
];

function note(text) {
  $('log').appendChild(el('div', 'row note', String(text)));
  scrollBottom(true);
}

/** Reconhece `/nome args` como comando do app. */
function parseAppCommand(text) {
  const m = String(text).match(/^\/([A-Za-z0-9:_-]+)\s*([\s\S]*)$/);
  if (!m) return null;
  const cmd = APP_COMMANDS.find(c => c.name === m[1]);
  return cmd ? { cmd, args: m[2].trim() } : null;
}

/* ===== fuzzy + recentes + /model com args (base da paleta global) ===== */
/** Subsequência com bônus de prefixo/contiguidade; -1 = não casa. */
function fuzzyScore(hay, q) {
  if (!q) return 0;
  let score = 0, hi = 0, streak = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const at = hay.indexOf(q[qi], hi);
    if (at < 0) return -1;
    if (at === hi) { streak++; score += 10 + streak * 5; }
    else { streak = 0; score += at === 0 ? 8 : 1; }
    if (at > 0 && /[\s\/_:-]/.test(hay[at - 1])) score += 4;
    hi = at + 1;
  }
  if (hay.startsWith(q)) score += 20;
  return score - hay.length * 0.01;
}

const RECENT_KEY = 'palette-recent';
const RECENT_MAX = 10;
let recentList = null;

function loadRecents() {
  if (recentList) return recentList;
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    recentList = Array.isArray(raw) ? raw.filter(x => typeof x === 'string').slice(0, RECENT_MAX) : [];
  } catch { recentList = []; }
  return recentList;
}

function saveRecents() {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(loadRecents())); } catch { /* sem storage */ }
}

/** Guarda `/comando [args]` no topo, sem duplicar, no máximo RECENT_MAX. */
function pushRecent(entry) {
  const e = String(entry || '').trim();
  if (!e) return;
  recentList = [e, ...loadRecents().filter(x => x !== e)].slice(0, RECENT_MAX);
  saveRecents();
}

function recentRank(entry) {
  const i = loadRecents().indexOf(entry);
  return i < 0 ? 999 : i;
}

const cmdk = { open: false, items: [], index: 0 };

/** Troca efetiva de modelo (seletor, /model <busca> e paleta global usam o mesmo). */
async function applyModel(m) {
  if (!m || !m.id) return;
  if (!current || !current.connected) {
    if (!(await ensureRpc())) return;
  }
  sendCommand({ type: 'set_model', provider: m.provider, modelId: m.id });
  sessionState = { ...(sessionState || {}), model: m };
  if (current) { const tb = tabs.find(x => x.key === current.key); if (tb) tb.model = m; }
  updateModelButton(m);
  pushRecent('/model ' + m.id);
  closeModelPop();
}

function findModels(q) {
  const needle = String(q || '').toLowerCase().trim();
  if (!needle || !Array.isArray(allModels)) return [];
  const exact = allModels.filter(m => m && m.id && String(m.id).toLowerCase() === needle);
  if (exact.length) return exact.slice(0, 10);
  return allModels
    .filter(m => m && m.id)
    .map(m => ({ m, s: fuzzyScore((m.id + ' ' + (m.name || '') + ' ' + (m.provider || '')).toLowerCase(), needle) }))
    .filter(x => x.s >= 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 10)
    .map(x => x.m);
}

/** `/model` sem args abre o seletor; com args tenta casar direto no catálogo. */
function runModelArg(args) {
  const q = String(args || '').trim();
  if (!q) { $('modeltoggle').click(); return; }
  const hits = findModels(q);
  if (hits.length === 1) { applyModel(hits[0]); return; }
  if ($('modelpop').classList.contains('hidden')) $('modeltoggle').click();
  $('modelsearch').value = q;
  renderModelList(q);
  if (!hits.length) note('modelo não encontrado para "' + q + '"');
  else note(hits.length + ' modelos para "' + q + '" — escolha no seletor');
}

/* =============== paleta de comandos (/) =============== */
let commandsCache = [];
const palette = { open: false, items: [], index: 0 };

function loadCachedCommands() {
  try {
    const c = JSON.parse(localStorage.getItem('commands-cache') || '[]');
    if (Array.isArray(c)) commandsCache = c;
  } catch { /* ignora */ }
}

function saveCommands(list) {
  commandsCache = list;
  try { localStorage.setItem('commands-cache', JSON.stringify(list)); } catch { /* sem storage */ }
}

/** Token `/algo` no fim do composer, sem espaço depois da barra. */
function slashToken() {
  const v = $('input').value;
  const m = v.match(/(^|\s)\/([^\s]*)$/);
  if (!m) return null;
  return { prefix: m[2], start: v.length - m[2].length };
}

function hidePalette() {
  if (cmdk.open) return; // paleta global gerencia o próprio ciclo
  palette.open = false;
  $('palette').classList.add('hidden');
}

function renderPalette() {
  const tok = slashToken();
  if (!tok) { hidePalette(); return; }

  // Primeira vez sem cache: precisa de sessão viva para pedir get_commands.
  if (!commandsCache.length) {
    ensureRpc().then((ok) => { if (ok) sendCommand({ type: 'get_commands' }); });
  }

  const q = tok.prefix.toLowerCase().slice(0, 120); // teto anti-jank em colagem gigante
  const seen = new Set();
  const items = [...APP_COMMANDS, ...commandsCache]
    .filter(c => {
      if (!c || !c.name) return false;
      const key = c.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return !q || fuzzyScore(key, q) >= 0;
    })
    .sort((a, b) => {
      if (q) {
        const sa = fuzzyScore(a.name.toLowerCase(), q);
        const sb = fuzzyScore(b.name.toLowerCase(), q);
        if (sa !== sb) return sb - sa;
      }
      // Sem busca (ou empate): recentes primeiro, depois alfabético.
      const ra = recentRank('/' + a.name);
      const rb = recentRank('/' + b.name);
      if (ra !== rb) return ra - rb;
      return a.name.localeCompare(b.name);
    })
    .slice(0, 60);

  if (!items.length) { hidePalette(); return; }

  palette.items = items;
  palette.open = true;
  if (palette.index >= items.length) palette.index = 0;

  const host = $('palettelist');
  clear(host);
  items.forEach((c, i) => {
    const row = el('div', 'palette-row' + (i === palette.index ? ' sel' : ''));
    row.appendChild(el('span', 'pname', '/' + c.name));
    row.appendChild(el('span', 'pdesc', c.description || ''));
    row.appendChild(el('span', 'psrc', c.app ? 'pi' : (c.source || '')));
    row.onclick = () => { palette.index = i; applyPaletteItem(false); };
    host.appendChild(row);
  });

  $('palette').classList.remove('hidden');
}

function applyPaletteItem(run) {
  const tok = slashToken();
  const cmd = palette.items[palette.index];
  if (!tok || !cmd) return;

  const v = $('input').value;
  const head = v.slice(0, tok.start - 1);
  $('input').value = head + '/' + cmd.name + ' ';
  autosizeInput();
  hidePalette();
  renderPalette(); // some com o token completo
  $('input').focus();
  if (run) send();
}

/* =============== paleta global (Cmd-K / Ctrl-K) =============== */
function cmdkCandidates() {
  const out = [];
  const seen = new Set();
  for (const c of [...APP_COMMANDS, ...commandsCache]) {
    if (!c || !c.name || seen.has(c.name)) continue;
    seen.add(c.name);
    out.push({ kind: 'cmd', cmd: c, title: '/' + c.name,
      desc: c.description || '', src: c.app ? 'pi' : (c.source || '') });
  }
  return out;
}

function openCmdk() {
  cmdk.open = true;
  cmdk.index = 0;
  palette.open = false;
  // Primeira vez sem cache: precisa de sessão viva para pedir get_commands.
  if (!commandsCache.length) {
    ensureRpc().then((ok) => { if (ok) sendCommand({ type: 'get_commands' }); });
  }
  $('cmdkbar').classList.remove('hidden');
  $('palettefoot').textContent = '↑↓ navegar · Enter executar · Esc fechar · sem busca: recentes primeiro';
  $('cmdkinput').value = '';
  renderCmdk();
  $('cmdkinput').focus();
}

function closeCmdk() {
  cmdk.open = false;
  $('cmdkbar').classList.add('hidden');
  $('palettefoot').textContent = '↑↓ selecionar · Tab completar · Enter executar · Esc fechar';
  $('palette').classList.add('hidden');
  if (document.activeElement === $('cmdkinput')) $('input').focus();
}

function toggleCmdk() {
  if (cmdk.open) closeCmdk(); else openCmdk();
}

function renderCmdk() {
  const raw = $('cmdkinput').value.trim().toLowerCase();
  const q = raw.replace(/^\/model\s+/, '').slice(0, 120); // teto anti-jank em colagem gigante
  const cmds = cmdkCandidates();
  const groups = [];
  if (!raw) {
    // Sem busca: recentes (só os que ainda existem) + comandos A–Z.
    const byTitle = new Map(cmds.map(c => [c.title.toLowerCase(), c]));
    const seenR = new Set();
    const recentRows = [];
    for (const r of loadRecents()) {
      const base = r.split(' ')[0].toLowerCase();
      let it = null;
      if (base === '/model' && r.length > 7) {
        const hit = (Array.isArray(allModels) ? allModels : [])
          .find(m => m && m.id && ('/model ' + m.id).toLowerCase() === r.toLowerCase());
        if (hit) it = { kind: 'model', model: hit, title: '/model ' + hit.id,
          desc: (hit.provider ? hit.provider + ' · ' : '') + (hit.name || hit.id), src: hit.provider || '' };
      } else if (byTitle.has(base)) {
        const c = byTitle.get(base);
        it = { kind: 'cmd', cmd: c.cmd, title: r, desc: c.desc, src: c.src, args: r.slice(base.length).trim() };
      }
      if (it && !seenR.has(it.title)) { seenR.add(it.title); recentRows.push(it); }
      if (recentRows.length >= RECENT_MAX) break;
    }
    if (recentRows.length) groups.push({ label: 'RECENTES', rows: recentRows });
    groups.push({ label: 'COMANDOS', rows: cmds
      .filter(c => ![...seenR].some(t => t.split(' ')[0].toLowerCase() === c.title.toLowerCase()))
      .sort((a, b) => a.title.localeCompare(b.title)) });
  } else {
    const cmdRows = cmds
      .map(c => ({ c, s: fuzzyScore((c.title + ' ' + c.desc).toLowerCase(), raw) }))
      .filter(x => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 30)
      .map(x => ({ kind: 'cmd', cmd: x.c.cmd, title: x.c.title, desc: x.c.desc, src: x.c.src }));
    if (cmdRows.length) groups.push({ label: 'COMANDOS', rows: cmdRows });
    const mRows = (Array.isArray(allModels) ? allModels : [])
      .map(m => ({ m, s: m && m.id
        ? fuzzyScore((m.id + ' ' + (m.name || '') + ' ' + (m.provider || '')).toLowerCase(), q) : -1 }))
      .filter(x => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 15)
      .map(x => ({ kind: 'model', model: x.m, title: '/model ' + x.m.id,
        desc: (x.m.provider ? x.m.provider + ' · ' : '') + (x.m.name || x.m.id), src: x.m.provider || '' }));
    if (mRows.length) groups.push({ label: 'MODELOS', rows: mRows });
  }
  cmdk.items = groups.flatMap(g => g.rows);
  if (cmdk.index >= cmdk.items.length) cmdk.index = 0;
  const host = $('palettelist');
  clear(host);
  if (!cmdk.items.length) {
    host.appendChild(el('div', 'model-empty', 'nenhum resultado'));
  } else {
    let k = 0;
    for (const g of groups) {
      if (!g.rows.length) continue;
      if (g.label) host.appendChild(el('div', 'palette-group', g.label));
      for (const it of g.rows) {
        const i = k++;
        const row = el('div', 'palette-row' + (i === cmdk.index ? ' sel' : ''));
        row.appendChild(el('span', 'pname', it.title));
        row.appendChild(el('span', 'pdesc', it.desc || ''));
        row.appendChild(el('span', 'psrc', it.src || ''));
        row.onclick = () => runCmdkItem(i);
        host.appendChild(row);
      }
    }
  }
  $('palette').classList.remove('hidden');
}

function runCmdkItem(i) {
  const it = cmdk.items[typeof i === 'number' ? i : cmdk.index];
  if (!it) return;
  if (it.kind === 'model') {
    const m = it.model;
    closeCmdk();
    applyModel(m); // registra o recente
    return;
  }
  const line = '/' + it.cmd.name + (it.args ? ' ' + it.args : '');
  if (!it.cmd.app) pushRecent(line);
  closeCmdk();
  if (!it.cmd.app) {
    // Comando de extensão: completa no composer (template, pode pedir args) sem enviar.
    $('input').value = line + ' ';
    $('input').focus();
    $('input').dispatchEvent(new Event('input'));
    return;
  }
  $('input').value = line;
  send(); // o ramo app do send() registra o recente e executa
}

$('cmdkinput').addEventListener('input', () => { cmdk.index = 0; renderCmdk(); });
$('cmdkinput').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (cmdk.items.length) { cmdk.index = (cmdk.index + 1) % cmdk.items.length; renderCmdk(); }
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (cmdk.items.length) { cmdk.index = (cmdk.index - 1 + cmdk.items.length) % cmdk.items.length; renderCmdk(); }
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    runCmdkItem(cmdk.index);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeCmdk();
  }
});

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && String(e.key).toLowerCase() === 'k') {
    // Atalhos existentes (p.ex. Ctrl+B do painel) ficam intactos: só o K é tratado aqui.
    e.preventDefault();
    toggleCmdk();
  } else if (e.key === 'Escape' && cmdk.open) {
    e.preventDefault();
    closeCmdk();
  }
});

/* =============== pacotes e MCP =============== */
function checkCommands(list) {
  const has = list.some(c => String((c && c.sourceInfo && c.sourceInfo.source) || '').includes('pi-subagents'));
  caps.subagents = has;
  if (has) {
    const warn = $('subs').querySelector('.warn-banner');
    if (warn) warn.remove();
  } else {
    applySubsWarning();
  }
  debugNote('pi-subagents carregado=' + has);
}

function noSubsMessage() {
  return caps.subagents === false
    ? 'pi-subagents não carregou nesta sessão (possível conflito de tool). Veja ⚙ → Pacotes e MCP.'
    : 'nenhum subagent';
}

function applySubsWarning() {
  const host = $('subs');
  // Só avisa quando a extensão de fato não carregou: sem esta condição o painel
  // repetia "nenhum subagent" (banner + vazio) depois de cada setEmpty.
  if (!host || caps.subagents !== false || host.querySelector('.warn-banner')) return;
  host.insertBefore(el('div', 'warn-banner', noSubsMessage()), host.firstChild);
}

async function loadPkgs(highlight) {
  $('pkglist').textContent = 'carregando…';
  try {
    const text = String(await inv('pi_list'));
    $('pkglist').textContent = text;
    installedSet = parseInstalledSources(text);
  } catch (e) {
    $('pkglist').textContent = String(e);
  }

  try {
    const raw = String(await inv('pi_mcp_list'));
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* veio texto de erro */ }
    $('mcpjson').textContent = parsed ? JSON.stringify(parsed, null, 2) : raw;
    renderMCP(parsed && Array.isArray(parsed.servers) ? parsed.servers : [], highlight);
  } catch (e) {
    setEmpty($('mcplist'), String(e));
  }

  if (catalogObjects) renderCatalog();
}

/* ---------- quais pacotes já estão instalados ---------- */
let installedSet = new Set();

function parseInstalledSources(text) {
  const set = new Set();
  for (const line of String(text).split('\n')) {
    // `pi list` usa 2 espaços para o source e 4 para o caminho resolvido
    const m = line.match(/^ {2}(?! )(\S.*)$/);
    if (!m) continue;
    let src = m[1].trim();
    if (src.startsWith('npm:')) src = src.slice(4);
    set.add(src);
  }
  return set;
}

/* ---------- servidores MCP ---------- */
function renderMCP(servers, highlight) {
  const host = $('mcplist');
  if (!servers.length) {
    setEmpty(host, 'nenhum servidor MCP configurado');
    return;
  }
  clear(host);
  for (const s of servers) {
    const row = el('div', 'mcp-row' + (highlight && s.name === highlight ? ' new' : ''));
    row.appendChild(el('span', 'mcp-name', String(s.name)));

    const state = String(s.state || '?');
    row.appendChild(el('span', 'mcp-chip' + (state === 'connected' ? ' ok' : (/error|fail/i.test(state) ? ' err' : '')), state));
    if (s.enabled === false) row.appendChild(el('span', 'mcp-chip off', 'disabled'));
    if (s.scope) row.appendChild(el('span', 'mcp-chip', String(s.scope)));

    row.appendChild(el('span', 'mcp-transport', String(s.transport || '')));
    if (Array.isArray(s.tools)) row.appendChild(el('span', 'mcp-chip', s.tools.length + ' tools'));

    const rm = el('button', 'ghost', 'Remover');
    rm.onclick = () => confirmRemoveMcp(s);
    row.appendChild(rm);
    host.appendChild(row);
  }
}

function confirmRemoveMcp(s) {
  const local = s.scope === 'project';
  confirmRun('pi mcp remove ' + s.name + (local ? ' -l' : ''), async () => {
    $('mcpout').textContent = 'removendo…';
    try {
      $('mcpout').textContent = String(await inv('pi_mcp_remove', { name: s.name, local }));
      await loadPkgs();
    } catch (e) {
      $('mcpout').textContent = String(e);
    }
  });
}

/* ---------- catálogo npm (keywords:pi-package) ---------- */
const CATALOG_KEY = 'catalog:pi-package';
const CATALOG_TTL = 3600 * 1000;
let catalogObjects = null;
let pendingAction = null;

function catalogFromCache() {
  try {
    const raw = JSON.parse(localStorage.getItem(CATALOG_KEY) || 'null');
    if (raw && raw.at && Date.now() - raw.at < CATALOG_TTL && Array.isArray(raw.items)) return raw.items;
  } catch { /* ignora */ }
  return null;
}

async function loadCatalog(force) {
  const host = $('catlist');
  if (!force) {
    const cached = catalogFromCache();
    if (cached) { catalogObjects = cached; renderCatalog(); return; }
  }
  setEmpty(host, 'consultando registry.npmjs.org…');
  try {
    const res = await fetch('https://registry.npmjs.org/-/v1/search?text=keywords:pi-package&size=250');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const items = (data.objects || [])
      .filter(o => o && o.package && (o.package.keywords || []).includes('pi-package'))
      .map(o => ({
        name: o.package.name,
        version: o.package.version,
        description: o.package.description || '',
        downloads: (o.downloads && o.downloads.monthly) || 0,
      }));
    catalogObjects = items;
    try { localStorage.setItem(CATALOG_KEY, JSON.stringify({ at: Date.now(), items })); } catch { /* sem storage */ }
    renderCatalog();
  } catch (e) {
    setEmpty(host, 'falha ao consultar o registry: ' + String(e));
  }
}

function renderCatalog() {
  const host = $('catlist');
  if (!catalogObjects) return;
  const q = String(($('catsearch') && $('catsearch').value) || '').toLowerCase();
  const rows = catalogObjects.filter(p => !q || (p.name + ' ' + p.description).toLowerCase().includes(q));
  clear(host);
  if (!rows.length) { setEmpty(host, 'nada encontrado'); return; }
  for (const p of rows) {
    const row = el('div', 'cat-row');
    row.appendChild(el('span', 'cat-name', p.name));
    row.appendChild(el('span', 'cat-meta', 'v' + p.version));
    row.appendChild(el('span', 'cat-desc', p.description));
    row.appendChild(el('span', 'cat-meta', p.downloads ? p.downloads + '/mês' : ''));
    if (installedSet.has(p.name)) {
      row.appendChild(el('span', 'cat-installed', 'instalado'));
      const rm = el('button', 'ghost', 'Remover');
      rm.onclick = () => askRemove(p);
      row.appendChild(rm);
    } else {
      const btn = el('button', 'ghost', 'Instalar…');
      btn.onclick = () => askInstall(p);
      row.appendChild(btn);
    }
    host.appendChild(row);
  }
  debugNote('catalogo=' + rows.length + '/' + catalogObjects.length);
}

/* ---------- confirmação explícita antes de escrever ---------- */
function confirmRun(cmdText, action) {
  pendingAction = action;
  $('confirmcmd').textContent = cmdText;
  $('confirmbar').classList.remove('hidden');
}

function closeConfirm() {
  pendingAction = null;
  $('confirmbar').classList.add('hidden');
}

function askInstall(p) {
  const spec = 'npm:' + p.name + '@' + p.version;
  confirmRun('pi install ' + spec, async () => {
    switchPkgPane('installed');
    $('pkglist').textContent = 'instalando ' + spec + '…';
    try {
      $('pkglist').textContent = String(await inv('pi_install', { spec, local: false }));
      await loadPkgs();
    } catch (e) {
      $('pkglist').textContent = String(e);
    }
  });
}

function askRemove(p) {
  const spec = 'npm:' + p.name;
  const extra = p.name === 'pi-subagents'
    ? '\n(o painel de subagents depende deste pacote)'
    : '';
  confirmRun('pi remove ' + spec + extra, async () => {
    switchPkgPane('installed');
    $('pkglist').textContent = 'removendo ' + spec + '…';
    try {
      $('pkglist').textContent = String(await inv('pi_remove', { spec, local: false }));
      await loadPkgs();
    } catch (e) {
      $('pkglist').textContent = String(e);
    }
  });
}

/* ---------- MCP ---------- */
// Só presets cujo pacote existe de fato no npm (verificado).
const MCP_PRESETS = {
  filesystem: { name: 'filesystem', target: 'npx -y @modelcontextprotocol/server-filesystem' },
  memory: { name: 'memory', target: 'npx -y @modelcontextprotocol/server-memory' },
  'sequential-thinking': { name: 'sequential-thinking', target: 'npx -y @modelcontextprotocol/server-sequential-thinking' },
};

/** Divide comando respeitando aspas simples/duplas (caminho com espaço). */
function splitArgs(text) {
  const out = [];
  let cur = '';
  let quote = null;
  for (const ch of String(text || '')) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ''; } continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function addEnvRow() {
  const row = el('div', 'env-row');
  const key = el('input', 'mfield env-k');
  key.placeholder = 'KEY';
  const val = el('input', 'mfield env-v');
  val.placeholder = 'valor ou nome da variável';
  const del = el('button', 'ghost', '×');
  del.onclick = () => row.remove();
  row.append(key, val, del);
  $('mcpenvrows').appendChild(row);
}

function collectEnv() {
  const env = [];
  document.querySelectorAll('#mcpenvrows .env-row').forEach(r => {
    const key = r.querySelector('.env-k').value.trim();
    const val = r.querySelector('.env-v').value;
    if (key) env.push(key + '=' + val);
  });
  return env;
}

function applyPreset(id) {
  const p = MCP_PRESETS[id];
  if (!p) return;
  $('mcpname').value = p.name;
  $('mcptarget').value = p.target;
  $('mcpargs').focus();
}

function mcpAdd() {
  const name = $('mcpname').value.trim();
  const target = $('mcptarget').value.trim();
  const extra = splitArgs($('mcpargs').value);
  const env = collectEnv();
  const local = $('mcplocal').checked;

  if (!name) { $('mcpout').textContent = 'informe o nome'; return; }
  if (!target) { $('mcpout').textContent = 'informe uma URL ou um comando'; return; }

  const isUrl = /^https?:\/\//i.test(target);
  const url = isUrl ? target : '';
  const argv = isUrl ? [] : splitArgs(target).concat(extra);

  const shown = 'pi mcp add ' + name + (local ? ' -l' : '') +
    env.map(e => ' --env ' + e).join('') +
    (url ? ' --url ' + url : ' -- ' + argv.join(' '));

  confirmRun(shown, async () => {
    $('mcpout').textContent = 'executando…';
    try {
      $('mcpout').textContent = String(await inv('pi_mcp_add', { name, url, argv, env, headers: [], local }));
      await loadPkgs(name);
    } catch (e) {
      $('mcpout').textContent = String(e);
    }
  });
}

function mcpRemove() {
  const name = $('mcpname').value.trim();
  const local = $('mcplocal').checked;
  if (!name) { $('mcpout').textContent = 'informe o nome'; return; }
  confirmRun('pi mcp remove ' + name + (local ? ' -l' : ''), async () => {
    try {
      $('mcpout').textContent = String(await inv('pi_mcp_remove', { name, local }));
      await loadPkgs();
    } catch (e) {
      $('mcpout').textContent = String(e);
    }
  });
}

/* ---------- panes ---------- */
/* ---------- hooks ---------- */
let hooksTimer = null;

async function loadHooks() {
  try {
    const raw = String(await inv('hooks_tail', { lines: 200 }));
    $('hookslog').textContent = raw.trim() ? raw : '(sem registros ainda) — dispare uma mensagem e volte aqui';
  } catch (e) {
    $('hookslog').textContent = String(e);
  }
}

async function refreshHooksStatus() {
  try {
    const st = JSON.parse(String(await inv('hooks_status')));
    $('setHooks').checked = !!st.installed;
    $('hooksstatus').textContent = (st.installed ? 'logger ativo · ' : 'logger inativo · ') + st.log;
  } catch { /* ignora */ }
}

function setHooksEnabled(on) {
  const cmd = on ? 'escrever ~/.pi/agent/extensions/sightdeck-hooks.js' : 'remover ~/.pi/agent/extensions/sightdeck-hooks.js';
  confirmRun(cmd, async () => {
    try {
      const out = await inv(on ? 'hooks_install' : 'hooks_remove');
      setStatus(String(out));
      await refreshHooksStatus();
      await loadHooks();
    } catch (e) {
      setStatus('erro: ' + e);
    }
  });
}

function switchPkgPane(name) {
  document.querySelectorAll('.pkg-tab').forEach(t => t.classList.toggle('active', t.dataset.pane === name));
  for (const p of ['installed', 'catalog', 'mcp', 'hooks']) {
    const node = $('pane-' + p);
    if (node) node.classList.toggle('hidden', p !== name);
  }
  if (hooksTimer) { clearInterval(hooksTimer); hooksTimer = null; }

  if (name === 'catalog' && !catalogObjects) loadCatalog(false);
  if (name === 'hooks') {
    loadHooks();
    refreshHooksStatus();
    hooksTimer = setInterval(loadHooks, 2500);
  }
}

function openPkgs() {
  $('settingspop').classList.add('hidden');
  $('pkgs').classList.remove('hidden');
  switchPkgPane('installed');
  loadPkgs();
  if (!$('mcpenvrows').childElementCount) addEnvRow();
}

/** Overlay Debug (⚙): Missões e Diagnóstico saíram do painel direito. */
function openDebug() {
  $('settingspop').classList.add('hidden');
  $('debug').classList.remove('hidden');
  loadMissions();
  renderDiag();
}

/* =============== tema (JSON) =============== */

/** Linha de status do overlay: quantas chaves entraram, quais foram ignoradas e o erro de parse. */
function showThemeNote(res, prefix) {
  const applied = Object.keys(res.ok).length;
  const parts = [];
  if (prefix) parts.push(prefix);
  parts.push(applied + ' aplicada(s)');
  if (res.ignored.length) parts.push(res.ignored.length + ' ignorada(s): ' + res.ignored.join(', '));
  if (res.error) parts.push(res.error);
  $('themenote').textContent = parts.join(' · ');
}

function openTheme() {
  $('settingspop').classList.add('hidden');
  $('theme').classList.remove('hidden');
  $('themejson').focus();
}

/* =============== auth do provider (perto da versão do pi) =============== */
let authProvider = null;
let authTimer = null;
let authProvidersCache = [];

async function openProvPicker() {
  $('provpick').classList.remove('hidden');
  $('provsearch').value = '';
  $('provcurrent').textContent = authProvider ? 'atual: ' + authProvider : '';
  setEmpty($('provlist'), 'carregando provedores…');
  try {
    authProvidersCache = JSON.parse(String(await inv('auth_providers')));
  } catch {
    authProvidersCache = [];
  }
  renderProviders('');
}

function closeProvPicker() { $('provpick').classList.add('hidden'); }

function renderProviders(filter) {
  const host = $('provlist');
  const q = String(filter || '').toLowerCase();
  const rows = authProvidersCache.filter(p => p && p.name && p.name.toLowerCase().includes(q));
  clear(host);
  if (!rows.length) { setEmpty(host, 'nenhum provedor encontrado'); return; }

  for (const p of rows) {
    const row = el('div', 'cat-row prov-row');
    row.appendChild(el('span', 'cat-name', p.name));

    if (p.status === 'ready') {
      row.appendChild(el('span', 'cat-installed', 'pronto'));
    } else if (p.configured) {
      row.appendChild(el('span', 'prov-nocred', 'sem credencial'));
    }

    const btn = el('button', 'ghost', 'logar');
    btn.onclick = () => { closeProvPicker(); startLogin(p.name); };
    row.appendChild(btn);
    host.appendChild(row);
  }
}

async function checkAuth() {
  let provider = sessionState && sessionState.model && sessionState.model.provider;
  if (!provider) {
    try {
      const m = JSON.parse(localStorage.getItem('last-model') || 'null');
      provider = m && m.provider;
    } catch { /* ignora */ }
  }
  if (!provider) { $('authchip').classList.add('hidden'); return; }
  authProvider = provider;

  try {
    const st = JSON.parse(String(await inv('auth_status', { provider })));
    const ready = !!st && st.status === 'ready';
    const chip = $('authchip');
    chip.classList.remove('hidden');
    chip.classList.toggle('ok', ready);
    chip.classList.toggle('warn', !ready);
    chip.textContent = ready ? 'auth ok' : 'logar ' + provider;
    chip.title = ready
      ? 'provider ' + provider + ' autenticado'
      : 'clique para abrir o terminal e rodar pi auth login ' + provider;
  } catch { /* sem pi no PATH */ }
}

async function startLogin(provider) {
  const p = (provider || authProvider || '').trim();
  if (!p) { setStatus('uso: /login <provider>'); return; }
  try {
    setStatus(String(await inv('open_terminal_login', { provider: p })));
  } catch (e) {
    setStatus(String(e));
  }

  if (authTimer) clearInterval(authTimer);
  let ticks = 0;
  authTimer = setInterval(async () => {
    ticks += 1;
    await checkAuth();
    if ($('authchip').classList.contains('ok') || ticks > 40) {
      clearInterval(authTimer);
      authTimer = null;
    }
  }, 3000);
}

/* =============== atualização (release latest do GitHub) =============== */
const UPDATE_KEY = 'update-check';
let appVersion = null;

function cmpVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function applyUpdateInfo(data) {
  const bar = $('updatebar');
  if (!bar || !data || !data.tag || !appVersion) return;
  if (cmpVersions(data.tag, appVersion) > 0) {
    $('updatetext').textContent = 'Atualização disponível: ' + data.tag +
      ' (você tem v' + appVersion + ')';
    bar.dataset.url = data.url || '';
    bar.classList.remove('hidden');
  } else {
    bar.classList.add('hidden');
  }
}

async function checkUpdate(manual) {
  if (!appVersion) return;
  if (manual) setStatus('verificando…');
  try {
    const cached = JSON.parse(localStorage.getItem(UPDATE_KEY) || 'null');
    if (!manual && cached && Date.now() - cached.at < 12 * 3600 * 1000) {
      applyUpdateInfo(cached.data);
      return;
    }

    const res = await fetch('https://api.github.com/repos/matheusbbdutra/sightdeck/releases/latest', {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const rel = await res.json();
    const data = { tag: rel.tag_name, url: rel.html_url };
    try { localStorage.setItem(UPDATE_KEY, JSON.stringify({ at: Date.now(), data })); } catch { /* sem storage */ }
    applyUpdateInfo(data);
    if (manual) {
      setStatus(cmpVersions(data.tag, appVersion) > 0 ? 'atualização disponível' : 'já está atualizado');
    }
  } catch (e) {
    if (manual) setStatus('falha ao verificar');
    debugNote('update check falhou: ' + e);
  }
}

/* =============== wiring =============== */
$('send').onclick = send;
$('stopbtn').onclick = () => abortTurn();
$('loadmorebtn').onclick = loadEarlier;
$('scrollbottom').onclick = () => {
  const l = $('log');
  l.scrollTo({ top: l.scrollHeight, behavior: 'smooth' });
};
$('log').addEventListener('scroll', () => {
  updateScrollBtn();
});
$('input').addEventListener('keydown', (e) => {
  if (palette.open) {
    if (e.key === 'ArrowDown') {
      palette.index = (palette.index + 1) % palette.items.length;
      renderPalette();
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowUp') {
      palette.index = (palette.index - 1 + palette.items.length) % palette.items.length;
      renderPalette();
      e.preventDefault();
      return;
    }
    if (e.key === 'Tab') { e.preventDefault(); applyPaletteItem(false); return; }
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); applyPaletteItem(true); return; }
    if (e.key === 'Escape') { e.preventDefault(); hidePalette(); return; }
  }
  if (e.key === 'Enter') {
    // Enter envia; Ctrl/Cmd+Enter quebra linha (Shift+Enter quebra nativo do textarea).
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const box = e.target;
      box.setRangeText('\n', box.selectionStart, box.selectionEnd, 'end');
      box.dispatchEvent(new Event('input'));
      return;
    }
    if (!e.shiftKey) { e.preventDefault(); send(); }
  }
});

$('input').addEventListener('input', () => { renderPalette(); autosizeInput(); });
$('input').addEventListener('blur', () => setTimeout(hidePalette, 150));

/* =============== anexos =============== */
function renderAttachments() {
  const row = $('attachrow');
  clear(row);
  pendingImages.forEach((img, i) => {
    const box = el('div', 'attach');
    const im = document.createElement('img');
    im.src = img.dataUrl;
    im.alt = 'imagem colada';
    const del = el('button', 'tiny', '×');
    del.title = 'Remover imagem';
    del.onclick = () => { pendingImages.splice(i, 1); renderAttachments(); };
    box.append(im, del);
    row.appendChild(box);
  });
  row.classList.toggle('hidden', pendingImages.length === 0);
}

/** Imagem enviada, exibida no transcript. */
function thumb(dataUrl) {
  const box = el('div', 'msg-img');
  const im = document.createElement('img');
  im.src = dataUrl;
  im.title = 'Clique para ampliar';
  im.onclick = () => {
    $('imgviewimg').src = dataUrl;
    $('imgview').classList.remove('hidden');
  };
  box.appendChild(im);
  return box;
}

$('imgview').onclick = () => $('imgview').classList.add('hidden');
$('imgviewimg').onclick = (e) => { e.stopPropagation(); $('imgview').classList.add('hidden'); };
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('imgview').classList.add('hidden');
});

function addImageFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const url = String(reader.result || '');
    const comma = url.indexOf(',');
    if (comma < 0) return;
    // dataUrl serve só para a miniatura; o RPC quer o base64 puro.
    pendingImages.push({ dataUrl: url, data: url.slice(comma + 1), mime: file.type || 'image/png' });
    renderAttachments();
  };
  reader.readAsDataURL(file);
}

// Print colado no composer: o pi aceita ImageContent no prompt (docs/rpc-commands.md).
$('input').addEventListener('paste', (e) => {
  const items = (e.clipboardData && e.clipboardData.items) || [];
  const files = [];
  for (const it of items) {
    if (it.kind === 'file' && String(it.type).startsWith('image/')) {
      const f = it.getAsFile();
      if (f) files.push(f);
    }
  }
  if (!files.length) return; // texto puro segue o caminho normal
  e.preventDefault();
  files.forEach(addImageFile);
});

// A WebKitGTK não entrega `image/*` no evento paste do webview: consulta o
// clipboard do sistema. Se não houver imagem, o texto cola normalmente (sem preventDefault).
$('input').addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'v') return;
  inv('paste_image')
    .then(([data, mime]) => {
      pendingImages.push({ dataUrl: 'data:' + mime + ';base64,' + data, data, mime });
      renderAttachments();
    })
    .catch(() => { /* clipboard sem imagem: colagem de texto nativa segue */ });
});

// Arquivo como contexto: o RPC não tem campo de arquivo, então entra como @caminho
// e o agente lê com as próprias tools.
$('attachbtn').onclick = async () => {
  try {
    const path = String(await inv('pick_file')).trim();
    if (!path) return;
    const box = $('input');
    const sep = box.value && !/\s$/.test(box.value) ? ' ' : '';
    box.value += sep + '@' + path + ' ';
    box.focus();
    box.dispatchEvent(new Event('input'));
  } catch (e) {
    if (!String(e).includes('cancelado')) setStatus(String(e));
  }
};

function applySubsVisibility(hidden) {
  document.body.classList.toggle('no-subs', hidden);
  $('togglesubs').classList.toggle('on', !hidden);
  try { localStorage.setItem('subs-hidden', hidden ? '1' : '0'); } catch { /* webview sem storage */ }
}
$('togglesubs').onclick = () =>
  applySubsVisibility(!document.body.classList.contains('no-subs'));

document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  if (e.key === 'b' || e.key === 'B') { e.preventDefault(); applySubsVisibility(!document.body.classList.contains('no-subs')); }
  else if (e.key === '+' || e.key === '=') { e.preventDefault(); setZoom(zoom + 0.1); }
  else if (e.key === '-') { e.preventDefault(); setZoom(zoom - 0.1); }
  else if (e.key === '0') { e.preventDefault(); setZoom(1); }
});

$('newsession').onclick = async () => {
  let cwd = '/';
  try { cwd = await inv('home_dir'); } catch { /* usa raiz */ }
  await newSessionIn(cwd);
};
$('addproject').onclick = () => addProject();
$('sesssearch').oninput = scheduleSearch;
$('sesssearch').onfocus = scheduleSearch;
$('toolfilter').oninput = scheduleSearch;
$('erronly').onchange = () => runSearch(false);
$('searchclear').onclick = clearSearch;

$('reload').onclick = reloadSession;
$('unque').onclick = () => desfazerFila();
$('forkbtn').onclick = async (e) => {
  e.stopPropagation();
  closeModelPop();
  if (!current) return note('sem sessão aberta');
  if (!current.connected && !(await ensureRpc())) return;
  sendCommand({ type: 'get_fork_messages' });
};
$('detailback').onclick = closeDetail;
// Clique fora da caixinha (no scrim) também volta — padrão dos overlays do projeto.
$('detail').addEventListener('mousedown', (e) => { if (e.target === $('detail')) closeDetail(); });

$('modeltoggle').onclick = (e) => {
  e.stopPropagation();
  $('modelpop').classList.toggle('hidden');
  if (!$('modelpop').classList.contains('hidden')) {
    $('modelsearch').value = '';
    renderModelList('');
    $('modelsearch').focus();
  }
};
$('modelsearch').oninput = (e) => renderModelList(e.target.value);
$('modelsearch').onkeydown = (e) => { if (e.key === 'Escape') closeModelPop(); };
$('thinkbtn').onclick = (e) => { e.stopPropagation(); $('modeltoggle').click(); };
$('thinkslider').oninput = (e) => {
  const lv = levelList[Number(e.target.value)];
  if (lv) $('thinkname').textContent = lv;
};
$('thinkslider').onchange = async (e) => {
  const key = current && current.key;
  const lv = levelList[Number(e.target.value)];
  if (!lv) return;
  if (!current || !current.connected) {
    if (!(await ensureRpc())) return;
  }
  if (!current || current.key !== key) return;
  sendCommand({ type: 'set_thinking_level', level: lv });
  sessionState = { ...(sessionState || {}), thinkingLevel: lv };
  if (current) { const tb = tabs.find(x => x.key === current.key); if (tb) tb.thinkingLevel = lv; }
  fillLevels(null);
};

document.addEventListener('click', (e) => {
  if (!$('modelpop').classList.contains('hidden')
    && !$('modelpop').contains(e.target) && !$('modeltoggle').contains(e.target)) closeModelPop();
  if (!$('forkpop').classList.contains('hidden') && !$('forkpop').contains(e.target)) closeForkPop();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('modelpop').classList.contains('hidden')) closeModelPop();
  if (e.key === 'Escape' && !$('forkpop').classList.contains('hidden')) closeForkPop();
});

function resetCompact() {
  compactBusy = false;
  $('compactnow').classList.remove('on');
  $('compactnow').title = 'Compactar agora (resume o histórico)';
}

function endCompact(text) {
  resetCompact();
  $('log').appendChild(el('div', 'row note', text));
  sendCommand({ type: 'get_session_stats' });
}

$('compactnow').onclick = () => {
  if (!current) return note('sem sessão aberta');
  if (compactBusy) return;
  compactBusy = true;
  $('compactnow').classList.add('on');
  $('compactnow').title = 'compactando…';
  sendCommand({ type: 'compact' });
};

$('autocompact').onclick = () => {
  const next = !(sessionState && sessionState.autoCompactionEnabled);
  sendCommand({ type: 'set_auto_compaction', enabled: next });
  sessionState = { ...(sessionState || {}), autoCompactionEnabled: next };
  $('autocompact').classList.toggle('on', next);
};

document.addEventListener('click', (e) => {
  const pop = $('ctxpop');
  if (pop.classList.contains('hidden')) return;
  if (pop.contains(e.target) || $('ctxbtn').contains(e.target)) return;
  pop.classList.add('hidden');
});

$('ctxbtn').onclick = () => {
  statsNoteRequested = true;
  sendCommand({ type: 'get_session_stats' });
  renderCtxPop();
  refreshCompactLimit();
  $('ctxpop').classList.toggle('hidden');
  $('modelpop').classList.add('hidden');
};

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem('ui-settings') || '{}');
    uiSettings.expandTools = !!raw.expandTools;
    uiSettings.expandThink = !!raw.expandThink;
    uiSettings.showHidden = !!raw.showHidden;
    uiSettings.notifyDesktop = raw.notifyDesktop !== false;
    uiSettings.notifySound = raw.notifySound !== false;
  } catch { /* defaults */ }
  $('setExpTools').checked = uiSettings.expandTools;
  $('setExpThink').checked = uiSettings.expandThink;
  $('setShowHidden').checked = uiSettings.showHidden;
  $('setNotifyDesktop').checked = uiSettings.notifyDesktop;
  $('setNotifySound').checked = uiSettings.notifySound;
}

function saveSettings() {
  try { localStorage.setItem('ui-settings', JSON.stringify(uiSettings)); } catch { /* sem storage */ }
}

$('settingsbtn').onclick = (e) => {
  e.stopPropagation();
  $('settingspop').classList.toggle('hidden');
};
$('setExpTools').onchange = (e) => { uiSettings.expandTools = e.target.checked; saveSettings(); };
$('setExpThink').onchange = (e) => { uiSettings.expandThink = e.target.checked; saveSettings(); };
$('setShowHidden').onchange = (e) => {
  uiSettings.showHidden = e.target.checked;
  saveSettings();
  loadSessions();
};
$('setNotifyDesktop').onchange = (e) => { uiSettings.notifyDesktop = e.target.checked; saveSettings(); };
$('setNotifySound').onchange = (e) => { uiSettings.notifySound = e.target.checked; saveSettings(); };

async function runUpdate(scope) {
  const out = $('updOut');
  out.textContent = 'rodando… (pode demorar)';
  try {
    out.textContent = String(await inv('pi_update', { scope }));
    try { $('piversion').textContent = 'pi ' + await inv('pi_version'); } catch { /* ignora */ }
  } catch (e) {
    out.textContent = String(e);
  }
}
$('updExt').onclick = () => runUpdate('extensions');
$('updPi').onclick = () => runUpdate('self');
$('pkgbtn').onclick = () => openPkgs();
$('themebtn').onclick = () => openTheme();
$('themeback').onclick = () => $('theme').classList.add('hidden');
$('themeapply').onclick = () => showThemeNote(applyTheme($('themejson').value), null);
$('themeexport').onclick = () => {
  const current = themeFromDom();
  $('themejson').value = JSON.stringify(current, null, 2);
  showThemeNote(validateTheme(current), 'exportado');
};
$('themereset').onclick = () => {
  resetTheme();
  $('themejson').value = '';
  $('themenote').textContent = 'tema padrão restaurado (localStorage[\'theme\'] removido)';
};
$('debugbtn').onclick = () => openDebug();
// Aviso de extensão não tem overlay próprio: o Diagnóstico já lista as linhas RPC.
$('healthchip').onclick = () => openDebug();
$('debugback').onclick = () => $('debug').classList.add('hidden');
$('debugrefresh').onclick = () => { loadMissions(); renderDiag(); };
$('checkupdate').onclick = () => checkUpdate(true);
$('updatebtn').onclick = () => {
  const u = $('updatebar').dataset.url;
  if (u) inv('open_external', { url: u }).catch(() => {});
};
$('updatedismiss').onclick = () => $('updatebar').classList.add('hidden');
$('authchip').onclick = () => {
  if ($('authchip').classList.contains('ok')) checkAuth();
  else openProvPicker();
};
$('provback').onclick = closeProvPicker;
$('provsearch').oninput = (e) => renderProviders(e.target.value);
$('pkgsback').onclick = () => $('pkgs').classList.add('hidden');
$('pkgsrefresh').onclick = () => {
  loadPkgs();
  if (!$('pane-catalog').classList.contains('hidden')) loadCatalog(true);
};
$('confirmok').onclick = async () => {
  const action = pendingAction;
  closeConfirm();
  if (action) await action();
};
$('confirmcancel').onclick = closeConfirm;
document.querySelectorAll('.pkg-tab').forEach(t => { t.onclick = () => switchPkgPane(t.dataset.pane); });
$('catsearch').oninput = () => renderCatalog();
$('hooksrefresh').onclick = () => { loadHooks(); refreshHooksStatus(); };
$('setHooks').onchange = (e) => setHooksEnabled(e.target.checked);
$('mcpadd').onclick = mcpAdd;
$('mcpremove').onclick = mcpRemove;
$('mcpenvadd').onclick = () => addEnvRow();
$('mcppreset').onchange = (e) => applyPreset(e.target.value);
document.addEventListener('click', (e) => {
  const pop = $('settingspop');
  if (pop.classList.contains('hidden')) return;
  if (pop.contains(e.target) || $('settingsbtn').contains(e.target)) return;
  pop.classList.add('hidden');
});

// Recarregar/fechar no meio do turno não perde abas nem o parcial em tela.
window.addEventListener('pagehide', () => {
  try { stashDraft(); } catch { /* ignora */ }
  try { saveTabs(); } catch { /* ignora */ }
});

applySubsVisibility((() => { try { return localStorage.getItem('subs-hidden') === '1'; } catch { return false; } })());
// Painel de subagents está sempre visível: clicar na tab é só um "atualizar"
// (run de subagent aparece no disco enquanto o turno roda, sem esperar o
// próximo agent_settled). O Git não é aba: fica fixo embaixo.
/** Aba do topo do painel direito: Subagents | Plano. Uma pane visível por vez,
    dentro do `.split-top` (o Git de baixo não participa). */
function switchPanelPane(name) {
  $('panelsubs').classList.toggle('active', name === 'subs');
  $('panelplans').classList.toggle('active', name === 'plans');
  $('subs').classList.toggle('hidden', name !== 'subs');
  $('plans').classList.toggle('hidden', name !== 'plans');
}

$('panelsubs').onclick = () => {
  switchPanelPane('subs');
  if (current && current.childrenDir) loadChildren(current.childrenDir);
};
// Ativar a aba relê: o `plans/*.md` muda no disco entre turnos, sem polling próprio.
$('panelplans').onclick = () => { switchPanelPane('plans'); loadPlans(); };
$('diagclear').onclick = () => { diagBuf.length = 0; diagPending.clear(); renderDiag(); };
initSplit();
initColumnResize();
// Dock do terminal: cwd/home vêm da sessão ativa (o PTY não segue trocas de sessão sozinho)
initTerminal({ getCwd: () => (current && current.cwd) || '' });
// Diff dos tool cards: `tool-cards.js` não pode importar `main.js` (ciclo).
setDiffRenderer(renderPatch);
setEmptyState(true, 'nosession');

loadSettings();
loadTreeState();
loadCachedModels();
loadLastModel();
loadCachedLevels();
loadCachedCommands();
warmModels();

(async () => {
  try { $('piversion').textContent = 'pi ' + await inv('pi_version'); } catch { /* sem versão */ }
  try { await inv('kill_orphans'); } catch { /* nada a limpar */ }
  try { appVersion = String(await inv('app_version')); } catch { appVersion = null; }
  checkUpdate(false);
  checkAuth();
  try { homeDir = await inv('home_dir'); } catch { homeDir = null; }
  restoreTabs();
  startGitPoll();
  await loadSessions();
  // Abas da sessão anterior voltam como leitura; o foco reconecta via ensureRpc.
  if (!current && activeTab) {
    try { await switchTab(activeTab.key); } catch { /* aba órfã: fica na barra para fechar */ }
  }
  try {
    const flags = String(await inv('debug_flags'));
    debugEnabled = flags.includes('debug');
    if (flags.includes('autonew')) $('newsession').click();
  } catch { /* sem flags */ }
})();
