import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { $, b64FromBytes, bytesFromB64 } from './shared.js';
import { inv, listen } from './rpc.js';

/* Terminal embutido: tool window no rodapé da coluna principal, abaixo do composer.
   Cada aba tem o seu PTY e o seu xterm; fechar o dock (Ctrl+`) só esconde — os
   processos continuam vivos e morrem com a janela (o backend faz kill_all). */

const DEFAULT_HEIGHT = 240;
const MIN_HEIGHT = 120;
const MAX_RATIO = 0.7; // 70% da viewport
const THEME = {
  background: '#12161f',
  foreground: '#dfe3ec',
  cursor: '#7aa2f7',
  cursorAccent: '#12161f',
  selectionBackground: '#2a3346',
};
const FONT = '"JetBrainsMono Nerd Font","JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace';
const enc = new TextEncoder();

let terms = [];   // { id, ptyId, term, fit, cwd, alive, opening, host, tab, dead }
let activeId = null;
let seq = 0;
let unData = null;   // unlisten de 'pty-data'
let unExit = null;   // unlisten de 'pty-exit'
let pending = [];    // eventos de um PTY ainda sem aba associada (o prompt inicial vem cedo)
let getCwd = () => '';

const dock = () => $('termdock');
const activeTerm = () => terms.find((t) => t.id === activeId) || null;
const byPtyId = (id) => terms.find((t) => t.ptyId === id) || null;

function readStore(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function store(key, value) {
  try { localStorage.setItem(key, String(value)); } catch { /* storage negado */ }
}

function showMsg(text) {
  const n = $('termmsg');
  if (n) n.textContent = text || '';
}

function maxHeight() {
  return Math.max(MIN_HEIGHT, Math.round(window.innerHeight * MAX_RATIO));
}

function currentHeight() {
  const d = dock();
  const h = d ? parseFloat(d.style.height) : NaN;
  return Number.isFinite(h) ? h : DEFAULT_HEIGHT;
}

function setHeight(px, persist) {
  const d = dock();
  if (!d) return;
  const h = Math.round(Math.min(maxHeight(), Math.max(MIN_HEIGHT, Number(px) || DEFAULT_HEIGHT)));
  d.style.height = h + 'px';
  if (persist) store('term-height', h);
}

function syncButton() {
  const d = dock();
  const btn = $('termbtn');
  if (btn && d) btn.classList.toggle('on', !d.classList.contains('hidden'));
}

function renderCwd() {
  const n = $('termcwd');
  if (!n) return;
  const t = activeTerm();
  const cwd = (t && t.cwd) || '';
  n.textContent = cwd || '—';
  const sess = String(getCwd() || '');
  // A sessão trocou de pasta: não reinicia sozinho, só sinaliza e deixa o botão reiniciar.
  const stale = Boolean(cwd && sess && sess !== cwd);
  n.classList.toggle('stale', stale);
  n.title = stale ? 'terminal em ' + cwd + ' · sessão em ' + sess + ' — use reiniciar' : 'diretório do terminal ativo';
}

/* fit só no host visível: medir um host com display:none devolve tamanho zerado. */
function fitTerm(t) {
  if (!t || !t.fit) return;
  const d = dock();
  if (!d || d.classList.contains('hidden')) return;
  if (t.host.classList.contains('hidden')) return;
  try { t.fit.fit(); } catch { /* host ainda sem tamanho */ }
}

let fitFrame = 0;
function fitActiveSoon() {
  if (fitFrame) return;
  fitFrame = requestAnimationFrame(() => {
    fitFrame = 0;
    fitTerm(activeTerm());
  });
}

function writeB64(t, b64) {
  if (!t || !t.term) return;
  try { t.term.write(bytesFromB64(b64)); } catch { /* base64 inválido: descarta */ }
}

function markExited(t) {
  t.ptyId = null;
  t.opening = false;
  t.alive = false;
  if (t.term) t.term.write('\r\n[processo terminou]\r\n');
  t.tab.classList.add('dead');
  t.dead.classList.remove('hidden');
  showMsg('processo terminou — use reiniciar');
}

function buffer(kind, p) {
  if (!terms.some((t) => t.opening)) return; // ninguém esperando id: evento órfão
  pending.push({ kind, p });
  if (pending.length > 400) pending.shift();
}

function onData(ev) {
  const p = ev && ev.payload ? ev.payload : ev;  // Tauri entrega {event, payload, id}
  if (!p || !p.id) return;
  const t = byPtyId(p.id);
  if (t) { writeB64(t, p.b64); return; }
  buffer('data', p);
}

function onExit(ev) {
  const p = ev && ev.payload ? ev.payload : ev;  // envelope do Tauri
  if (!p || !p.id) return;
  const t = byPtyId(p.id);
  if (t) { markExited(t); return; }
  buffer('exit', p);
}

function flushPending(t) {
  const rest = [];
  for (const e of pending) {
    if (e.p.id !== t.ptyId) { rest.push(e); continue; }
    if (e.kind === 'data') writeB64(t, e.p.b64);
    else markExited(t);
  }
  pending = rest;
}

let listenersPromise = null;
// Memoizado: initTerminal e openTerminal chamam quase juntos, e sem isso o
// segundo registro duplicava os listeners (cada evento entregue duas vezes).
async function ensureListeners() {
  if (listenersPromise) return listenersPromise;
  listenersPromise = (async () => {
    unData = await listen('pty-data', onData);
    unExit = await listen('pty-exit', onExit);
  })();
  try { await listenersPromise; } catch (e) { listenersPromise = null; throw e; }
}

function dropListeners() {
  if (unData) { try { unData(); } catch { /* já removido */ } unData = null; }
  if (unExit) { try { unExit(); } catch { /* já removido */ } unExit = null; }
}

async function openPty(t) {
  // Sem sessão o cwd vem vazio: abrir em `/` era o bug — o shell tem que nascer
  // na pasta da sessão, então espera a sessão (reconcileTerminal retoma depois).
  const cwd = String(getCwd() || '');
  if (!cwd) {
    t.ptyId = null;
    showMsg('abra uma sessão para o terminal herdar a pasta');
    return;
  }
  t.opening = true;
  showMsg('');
  try {
    const id = await inv('pty_open', { cwd, cols: t.term.cols || 80, rows: t.term.rows || 24 });
    t.ptyId = String(id);
    t.cwd = cwd;
    t.opening = false;
    flushPending(t);
    renderCwd();
  } catch (err) {
    t.ptyId = null;
    t.opening = false;
    pending = [];
    showMsg('não foi possível abrir o terminal: ' + (err && err.message ? err.message : err));
  }
}

async function closePty(t) {
  const id = t.ptyId;
  t.ptyId = null;
  t.opening = false;
  if (!id) return;
  pending = pending.filter((e) => e.p.id !== id);
  try { await inv('pty_close', { id }); } catch { /* já morreu */ }
}

function activate(id) {
  const t = terms.find((x) => x.id === id);
  if (!t) return;
  activeId = id;
  for (const x of terms) {
    const on = x.id === id;
    x.host.classList.toggle('hidden', !on);
    x.tab.classList.toggle('active', on);
  }
  renderCwd();
  requestAnimationFrame(() => {
    fitTerm(t);
    t.term.focus();
  });
}

function addTab() {
  const hosts = $('termhosts');
  const list = $('termtabs');
  if (!hosts || !list) return null;

  seq += 1;
  const id = 'tab' + seq;

  const host = document.createElement('div');
  host.className = 'term-host';
  hosts.appendChild(host);

  const tab = document.createElement('div');
  tab.className = 'term-tab';
  tab.title = 'terminal ' + seq;
  const label = document.createElement('span');
  label.className = 'term-label';
  label.textContent = 'terminal ' + seq;
  const dead = document.createElement('span');
  dead.className = 'term-dead hidden';
  dead.textContent = '[terminou]';
  const x = document.createElement('button');
  x.className = 'term-tab-x';
  x.title = 'fechar esta aba';
  x.textContent = '×';
  tab.append(label, dead, x);
  list.appendChild(tab);

  const term = new Terminal({
    fontFamily: FONT,
    fontSize: 12,
    lineHeight: 1.15,
    theme: THEME,
    cursorBlink: true,
    scrollback: 5000,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const t = { id, ptyId: null, term, fit, cwd: '', alive: true, opening: false, host, tab, dead };
  term.open(host);
  term.onData((d) => {
    t.touched = true;
    if (!t.ptyId) return;
    inv('pty_write', { id: t.ptyId, b64: b64FromBytes(enc.encode(d)) })
      .catch((err) => showMsg('falha ao escrever no terminal: ' + (err && err.message ? err.message : err)));
  });
  term.onResize(({ cols, rows }) => {
    if (!t.ptyId) return;
    inv('pty_resize', { id: t.ptyId, cols, rows }).catch(() => { /* resize é best-effort */ });
  });

  tab.onclick = () => activate(t.id);
  x.onclick = (e) => { e.stopPropagation(); void closeTab(t); };

  terms.push(t);
  return t;
}

async function newTab() {
  const t = addTab();
  if (!t) return;
  activate(t.id);
  // espera o layout da aba para o pty_open já sair com cols/rows certos
  await new Promise((r) => requestAnimationFrame(r));
  fitTerm(t);
  await openPty(t);
  t.term.focus();
}

async function closeTab(t) {
  const wasActive = t.id === activeId;
  await closePty(t);
  try { t.term.dispose(); } catch { /* já descartado */ }
  t.host.remove();
  t.tab.remove();
  terms = terms.filter((x) => x !== t);
  if (!terms.length) { closeTerminal(); return; } // última aba: não há PTY a preservar
  if (wasActive) activate(terms[terms.length - 1].id);
}

async function restart() {
  const t = activeTerm();
  if (!t) return;
  await closePty(t);
  t.alive = true;
  t.tab.classList.remove('dead');
  t.dead.classList.add('hidden');
  t.term.reset();
  fitTerm(t);
  await openPty(t);
  t.term.focus();
}

async function restartTab(t) {
  await closePty(t);
  t.alive = true;
  t.tab.classList.remove('dead');
  t.dead.classList.add('hidden');
  t.term.reset();
  fitTerm(t);
  await openPty(t);
}

/* Chamado quando a sessão em foco muda: terminal ainda sem PTY herda o cwd, e um
   terminal que ninguém digitou ainda muda de pasta sozinho. Terminal em uso nunca
   é morto — nesse caso só marca "stale" e espera o reiniciar. */
export function reconcileTerminal() {
  const d = dock();
  if (!d || d.classList.contains('hidden')) return;
  const t = activeTerm();
  if (!t) return;
  const sess = String(getCwd() || '');
  if (!t.ptyId && t.alive) { if (sess) void openPty(t); return; }
  if (sess && t.cwd && sess !== t.cwd && !t.touched) void restartTab(t);
}

export async function openTerminal() {
  const d = dock();
  if (!d) return;
  d.classList.remove('hidden');
  store('term-open', '1');
  syncButton();
  // listeners antes do pty_open: o prompt inicial pode sair antes de recebermos o id
  await ensureListeners();
  setHeight(currentHeight(), false);
  if (!terms.length) addTab();
  const id = activeId && terms.some((t) => t.id === activeId) ? activeId : terms[0].id;
  activate(id);
  await new Promise((r) => requestAnimationFrame(r));
  const t = activeTerm();
  fitTerm(t);
  // aba morta (processo terminou) mantém o output: só reinicia se o usuário pedir
  if (t && !t.ptyId && t.alive) await openPty(t);
  if (t) t.term.focus();
}

export function closeTerminal() {
  const d = dock();
  if (!d) return;
  d.classList.add('hidden');
  store('term-open', '0');
  syncButton();
}

export function toggleTerminal() {
  const d = dock();
  if (!d) return;
  if (d.classList.contains('hidden')) openTerminal();
  else closeTerminal();
}

export function initTerminal(opts = {}) {
  getCwd = typeof opts.getCwd === 'function' ? opts.getCwd : () => '';
  const d = dock();
  if (!d) return;

  setHeight(readStore('term-height') || DEFAULT_HEIGHT, false);
  renderCwd();
  void ensureListeners();

  const grip = $('termgrip');
  if (grip) {
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = d.getBoundingClientRect().height;
      grip.setPointerCapture(e.pointerId);
      const move = (ev) => { setHeight(startH + (startY - ev.clientY), false); fitActiveSoon(); };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        setHeight(d.getBoundingClientRect().height, true);
        fitActiveSoon();
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up, { once: true });
    });
  }

  const btn = $('termbtn');
  if (btn) btn.onclick = () => toggleTerminal();
  const plus = $('termnew');
  if (plus) plus.onclick = () => void newTab();
  const rs = $('termrestart');
  if (rs) rs.onclick = () => void restart();
  const close = $('termclose');
  if (close) close.onclick = () => closeTerminal();

  // capture: o xterm escuta no textarea dele e não deve receber o Ctrl+`
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key === '`') {
      e.preventDefault();
      e.stopPropagation();
      toggleTerminal();
    }
  }, true);

  window.addEventListener('resize', () => {
    setHeight(currentHeight(), false); // re-clampa se a janela encolheu
    if (!d.classList.contains('hidden')) fitActiveSoon();
  });
  window.addEventListener('pagehide', () => {
    for (const t of terms) void closePty(t);
    dropListeners();
  });

  syncButton();
  if (readStore('term-open') === '1') void openTerminal();
}
