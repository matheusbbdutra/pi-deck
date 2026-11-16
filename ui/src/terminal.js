import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { $, b64FromBytes, bytesFromB64 } from './shared.js';
import { inv, listen } from './rpc.js';

/* Terminal embutido: dock na coluna principal, entre o transcript (#log, flex:1)
   e o composer. Como o #log mantém o próprio scroll, o dock ocupa altura fixa e
   não mexe no comportamento de rolagem do transcript. */

const DEFAULT_HEIGHT = 220;
const MIN_HEIGHT = 120;
const MAX_RATIO = 0.7;   // 70% da viewport
const THEME = {
  background: '#0d1117',
  foreground: '#dfe3ec',
  cursor: '#7aa2f7',
  selectionBackground: '#26314a',
};
const FONT = '"JetBrainsMono Nerd Font","JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace';
const enc = new TextEncoder();

let term = null;
let fitAddon = null;
let ptyId = null;        // null = sem processo vivo (fechado ou terminou)
let ptyCwd = '';         // cwd com que o PTY atual foi aberto (não segue a sessão)
let unData = null;       // unlisten de 'pty-data'
let unExit = null;       // unlisten de 'pty-exit'
let opening = false;     // pty_open em voo
let early = [];          // eventos que chegaram antes de conhecermos o id (o prompt inicial vem cedo)
let getCwd = () => '';
let getHome = () => '';

const dock = () => $('termdock');

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
  n.textContent = ptyCwd || '—';
  const sess = String(getCwd() || '');
  // A sessão trocou de pasta: não reinicia sozinho, só sinaliza e deixa o botão reiniciar.
  const stale = Boolean(ptyCwd && sess && sess !== ptyCwd);
  n.classList.toggle('stale', stale);
  n.title = stale ? 'terminal em ' + ptyCwd + ' · sessão em ' + sess + ' — use reiniciar' : 'diretório do terminal';
}

let fitFrame = 0;
function fitNow() {
  if (!term || !fitAddon) return;
  try { fitAddon.fit(); } catch { /* host ainda sem tamanho */ }
}

// durante o arrasto/resize: no máximo um fit por frame
function fitAndResize() {
  if (!term || !fitAddon || !dock() || dock().classList.contains('hidden')) return;
  if (fitFrame) return;
  fitFrame = requestAnimationFrame(() => {
    fitFrame = 0;
    fitNow();
  });
}

function writeB64(b64) {
  if (!term) return;
  try { term.write(bytesFromB64(b64)); } catch { /* base64 inválido: descarta */ }
}

function markExited() {
  ptyId = null;
  if (term) term.write('\r\n[processo terminou]\r\n');
  const d = dock();
  if (d) d.classList.add('dead');
  showMsg('processo terminou — use reiniciar');
}

function onData(p) {
  if (!p || !p.id) return;
  if (ptyId === null && opening) { early.push({ kind: 'data', p }); return; }
  if (p.id !== ptyId) return;
  writeB64(p.b64);
}

function onExit(p) {
  if (!p || !p.id) return;
  if (ptyId === null && opening) { early.push({ kind: 'exit', p }); return; }
  if (p.id !== ptyId) return;
  markExited();
}

function flushEarly() {
  opening = false;
  for (const e of early.splice(0)) {
    if (!e.p || e.p.id !== ptyId) continue;
    if (e.kind === 'data') writeB64(e.p.b64);
    else markExited();
  }
}

async function ensureListeners() {
  if (unData || unExit) return;
  unData = await listen('pty-data', onData);
  unExit = await listen('pty-exit', onExit);
}

function dropListeners() {
  if (unData) { try { unData(); } catch { /* já removido */ } unData = null; }
  if (unExit) { try { unExit(); } catch { /* já removido */ } unExit = null; }
}

async function teardownPty() {
  const id = ptyId;
  ptyId = null;
  opening = false;
  early = [];
  dropListeners();
  if (id) { try { await inv('pty_close', { id }); } catch { /* já morreu */ } }
}

function createTerm() {
  term = new Terminal({
    fontFamily: FONT,
    fontSize: 12,
    theme: THEME,
    cursorBlink: true,
    scrollback: 5000,
  });
  fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open($('termhost'));
  term.onData((d) => {
    if (!ptyId) return;
    inv('pty_write', { id: ptyId, b64: b64FromBytes(enc.encode(d)) })
      .catch((err) => showMsg('falha ao escrever no terminal: ' + (err && err.message ? err.message : err)));
  });
  term.onResize(({ cols, rows }) => {
    if (!ptyId) return;
    inv('pty_resize', { id: ptyId, cols, rows }).catch(() => { /* resize é best-effort */ });
  });
}

async function openPty() {
  if (!term) return;
  const cwd = String(getCwd() || getHome() || '/');
  opening = true;
  showMsg('');
  const d = dock();
  if (d) d.classList.remove('dead');
  try {
    const id = await inv('pty_open', { cwd, cols: term.cols || 80, rows: term.rows || 24 });
    ptyId = String(id);
    ptyCwd = cwd;
    renderCwd();
    flushEarly();
  } catch (err) {
    ptyId = null;
    opening = false;
    early = [];
    showMsg('não foi possível abrir o terminal: ' + (err && err.message ? err.message : err));
  }
}

async function restart() {
  const id = ptyId;
  ptyId = null;
  if (id) { try { await inv('pty_close', { id }); } catch { /* já morreu */ } }
  if (term) term.reset();
  setHeight(currentHeight(), false);
  fitNow();
  await openPty();
  if (term) term.focus();
}

export async function openTerminal() {
  const d = dock();
  if (!d) return;
  d.classList.remove('hidden');
  store('term-open', '1');
  syncButton();
  if (!term) createTerm();
  // espera o layout do dock: o pty_open já precisa de cols/rows ajustados
  await new Promise((r) => requestAnimationFrame(r));
  setHeight(currentHeight(), false);
  fitNow();
  // listeners antes do pty_open: o prompt inicial pode sair antes de recebermos o id
  await ensureListeners();
  if (!ptyId) await openPty();
  if (term) term.focus();
}

export function closeTerminal() {
  const d = dock();
  if (!d) return;
  d.classList.add('hidden');
  store('term-open', '0');
  syncButton();
  teardownPty();
}

export function toggleTerminal() {
  const d = dock();
  if (!d) return;
  if (d.classList.contains('hidden')) openTerminal();
  else closeTerminal();
}

export function initTerminal(opts = {}) {
  getCwd = typeof opts.getCwd === 'function' ? opts.getCwd : () => '';
  getHome = typeof opts.getHome === 'function' ? opts.getHome : () => '';
  const d = dock();
  if (!d) return;

  setHeight(readStore('term-height') || DEFAULT_HEIGHT, false);
  renderCwd();

  const grip = $('termgrip');
  if (grip) {
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = d.getBoundingClientRect().height;
      grip.setPointerCapture(e.pointerId);
      const move = (ev) => { setHeight(startH + (startY - ev.clientY), false); fitAndResize(); };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        setHeight(d.getBoundingClientRect().height, true);
        fitAndResize();
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up, { once: true });
    });
  }

  const btn = $('termbtn');
  if (btn) btn.onclick = () => toggleTerminal();
  const close = $('termclose');
  if (close) close.onclick = () => closeTerminal();
  const rs = $('termrestart');
  if (rs) rs.onclick = () => restart();

  // capture: o xterm escuta no textarea dele e não deve receber o Ctrl+`
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key === '`') {
      e.preventDefault();
      e.stopPropagation();
      toggleTerminal();
    }
  }, true);

  window.addEventListener('resize', () => {
    if (d.classList.contains('hidden')) setHeight(currentHeight(), false); // re-clampa se a janela encolheu
    else fitAndResize();
  });
  window.addEventListener('pagehide', () => { teardownPty(); });

  syncButton();
  if (readStore('term-open') === '1') openTerminal();
}
