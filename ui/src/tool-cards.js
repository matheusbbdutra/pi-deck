import { $, el, clear, scrollBottom, uiSettings, cards } from './shared.js';

/* =============== tool cards =============== */

/* Registry de corpo por tool.
 *
 *   renderer(node, payload) -> sink(text)
 *
 *   node    wrapper do corpo do card (`<div>` já anexado ao card, começa vazio;
 *           o que o renderer montar dentro ganha `.tool-body` para herdar estilo
 *           e o colapso do card).
 *   payload { name, args, path, patch } — `args` cru da toolCall; `path` vem de
 *           args.path/args.file_path; `patch` vem de args.patch ('' se não houver).
 *   sink    desenha o texto do resultado (`outputText`) quando ele chega; é o
 *           único ponto que recebe o texto, então truncar/wrap é decisão do renderer.
 *
 * Sem renderer registrado o card usa o default: o texto do resultado num
 * `<pre class="tool-body">`. O diff do `renderPatch` **não** pode ser importado
 * aqui (o `main.js` já importa este módulo): ele é injetado uma vez no boot via
 * `setDiffRenderer`.
 */
const renderers = new Map();
let diffRenderer = null;

export function setToolRenderer(name, fn) { renderers.set(name, fn); }
export function rendererFor(name) { return renderers.get(name) || null; }
export function setDiffRenderer(fn) { diffRenderer = fn || null; }

/* =============== helpers =============== */

function argBody(args) {
  return (args && args.args) || args || {};
}

function pathOf(args) {
  const a = argBody(args);
  return String(a.path || a.file_path || '');
}

function patchFromArgs(args) {
  const a = argBody(args);
  return typeof a.patch === 'string' ? a.patch : '';
}

function patchOfResult(raw) {
  const d = raw && raw.details;
  return d && typeof d.patch === 'string' ? d.patch : '';
}

function nowTime(ms) {
  const d = ms ? new Date(ms) : new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/* ferramentas de leitura: linha de sumário em vez do dump cru do resultado */
const LIST_SUFFIX = { read: 'linhas', grep: 'matches', find: 'entradas', ls: 'entradas', glob: 'entradas' };
const MAX_OUT_LINES = 200;

function truncateLines(text) {
  const s = String(text == null ? '' : text);
  const lines = s.split('\n');
  if (lines.length <= MAX_OUT_LINES) return s;
  return lines.slice(0, MAX_OUT_LINES).join('\n')
    + '\n… saída truncada (' + (lines.length - MAX_OUT_LINES) + ' de ' + lines.length + ' linhas)';
}

/** Linhas do resultado sem as vazias do fim (a tool não manda contagem pronta). */
function resultLines(text) {
  const lines = String(text == null ? '' : text).split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines;
}

/** Sumário de `read`/`grep`/`find`/`ls`/`glob`; '' quando não dá para inferir
 *  (aí o renderer cai no texto cru do resultado). */
function summarizeResult(name, args, text) {
  const a = argBody(args);
  const suffix = LIST_SUFFIX[name];
  const subject = a.pattern ? '/' + a.pattern + '/' : pathOf(args);
  const lines = resultLines(text);
  if (!suffix || !subject || !lines.length) return '';
  const n = name === 'grep' ? lines.filter((l) => l.trim()).length : lines.length;
  return name + ' · ' + subject + ' · ' + n + ' ' + suffix;
}

/** Corpo montado a partir do texto do resultado. `reshape` pode devolver o
 *  texto que ele quiser; string vazia volta ao texto cru. */
function textRenderer(reshape) {
  return (node, payload) => {
    const pre = el('pre', 'tool-body');
    node.appendChild(pre);
    return (text) => { pre.textContent = reshape(payload, text) || text; };
  };
}

/* =============== diff (injetado) =============== */

/** Monta o diff no wrapper do card (substituindo o que houver); `false` se o
 *  renderer ainda não foi injetado — aí o corpo fica como está. */
function drawDiff(node, patch, path) {
  if (!diffRenderer || !patch) return false;
  clear(node);
  // `.tool-body` no box: é o seletor que o colapso do card esconde. Os overrides
  // inline evitam borda/padding/max-height duplicados dentro do corpo do card.
  const box = el('div', 'diff tool-body');
  box.style.cssText = 'margin:0;border:none;border-radius:0;padding:0;max-height:none;overflow:visible';
  const body = el('div', 'diff-body');
  box.appendChild(body);
  node.appendChild(box);
  diffRenderer(body, patch, path, path);
  return true;
}

/* =============== renderers =============== */

function bashRenderer(node, payload) {
  const cmd = el('div', 'tool-body', '$ ' + String(argBody(payload.args).command || ''));
  cmd.style.cssText = 'white-space:pre-wrap;overflow-x:hidden;color:var(--mute)';
  const out = el('pre', 'tool-body');
  out.style.cssText = 'white-space:pre-wrap;overflow-x:hidden';
  node.append(cmd, out);
  return (text) => { out.textContent = truncateLines(text); };
}

/** `edit`/`write`: diff quando há patch (args ou resultado, ver `applyToolResult`);
 *  sem patch o card fica com o texto do resultado, como antes. */
function editRenderer(node, payload) {
  if (payload.patch && drawDiff(node, payload.patch, payload.path)) return () => {};
  const pre = el('pre', 'tool-body');
  node.appendChild(pre);
  return (text) => { pre.textContent = text; };
}

/** `write`: o resultado da tool não traz patch — mostra o conteúdo enviado nos
 *  args (diff sintético fica fora: só o Rust monta um, no painel Arquivos). */
function writeRenderer(node, payload) {
  const content = typeof argBody(payload.args).content === 'string' ? argBody(payload.args).content : '';
  if (payload.patch && drawDiff(node, payload.patch, payload.path)) return () => {};
  const label = el('div', 'tool-body', 'write · ' + (payload.path || '—'));
  label.style.cssText = 'color:var(--mute)';
  const out = el('pre', 'tool-body');
  out.style.cssText = 'white-space:pre-wrap;overflow-x:hidden';
  out.textContent = truncateLines(content);
  const note = el('div', 'tool-body');
  note.style.cssText = 'color:var(--mute)';
  node.append(label, out, note);
  // O texto do resultado ("gravado") é curto; fica na nota para erro não sumir.
  return (text) => { note.textContent = truncateLines(text); };
}

const defaultRenderer = (node) => {
  const pre = el('pre', 'tool-body');
  node.appendChild(pre);
  return (text) => { pre.textContent = text; };
};

setToolRenderer('bash', bashRenderer);
setToolRenderer('edit', editRenderer);
setToolRenderer('write', writeRenderer);
setToolRenderer('read', textRenderer((p, t) => summarizeResult(p.name, p.args, t)));
setToolRenderer('grep', textRenderer((p, t) => summarizeResult(p.name, p.args, t)));
setToolRenderer('find', textRenderer((p, t) => summarizeResult(p.name, p.args, t)));
setToolRenderer('ls', textRenderer((p, t) => summarizeResult(p.name, p.args, t)));
setToolRenderer('glob', textRenderer((p, t) => summarizeResult(p.name, p.args, t)));

/* =============== cards =============== */

function summarize(name, args) {
  if (!args) return '';
  const a = argBody(args);
  if (name === 'bash') return '$ ' + (a.command || '');
  if (a.path || a.file_path) return String(a.path || a.file_path).replace(/^.*\/(?=[^/]+$)/, '');
  if (a.pattern) return '/' + a.pattern + '/';
  if (a.agent) return a.agent + (a.task ? ' · ' + a.task : '');
  if (a.query) return a.query;
  if (a.url) return a.url;
  const k = Object.keys(a)[0];
  return k ? k + '=' + String(a[k]).slice(0, 60) : '';
}

export function thinkBlock(text) {
  const open = uiSettings.expandThink;
  const wrap = el('div', 'think-block' + (open ? '' : ' collapsed'));
  const head = el('button', 'think-head', open ? 'thinking ▾' : 'thinking ▸');
  const body = el('pre', 'think-body', text);
  head.onclick = () => {
    const collapsed = wrap.classList.toggle('collapsed');
    head.textContent = collapsed ? 'thinking ▸' : 'thinking ▾';
  };
  wrap.append(head, body);
  return wrap;
}

export function card(callId, name, args, ctx, timeMs) {
  const target = (ctx && ctx.target) || $('log');
  const store = (ctx && ctx.store) || cards;

  const root = el('div', 'tool-card');
  const head = el('div', 'tool-head');
  const icon = el('span', 'tool-icon', '•');
  const time = el('span', 'tool-time', nowTime(timeMs));
  head.append(icon, el('span', 'tool-name', name || 'tool'), el('span', 'tool-args', summarize(name, args)), time);

  // Wrapper sem estilo próprio: o renderer decide o que entra (texto, diff, bloco).
  const body = el('div');
  root.append(head, body);
  head.addEventListener('click', () => root.classList.toggle('collapsed'));

  if (!uiSettings.expandTools) root.classList.add('collapsed');

  const entry = {
    root, body, icon, time,
    name: name || '',
    args: args || null,
    path: pathOf(args),
    patch: patchFromArgs(args),
  };
  const renderer = rendererFor(name);
  const payload = { name: entry.name, args: entry.args, path: entry.path, patch: entry.patch };
  entry.sink = (renderer && renderer(body, payload)) || defaultRenderer(body, payload);

  target.appendChild(root);
  if (!ctx) scrollBottom();
  if (callId) store.set(callId, entry);
  return entry;
}

/** Resultado da tool no card: texto (como sempre) e, quando o resultado traz
 *  `details.patch`, o diff no lugar do texto. Status/colapso ficam com o chamador. */
export function applyToolResult(entry, raw) {
  if (!entry || !entry.sink) return;
  const out = outputText(raw);
  const patch = patchOfResult(raw) || entry.patch || '';
  if (patch && drawDiff(entry.body, patch, entry.path)) return;
  if (out) entry.sink(out);
}

export function outputText(result) {
  const MAX = 20000;
  const cap = (s) => (s.length > MAX ? s.slice(0, MAX) + '\n… (' + (s.length - MAX) + ' caracteres truncados)' : s);

  if (!result) return '';
  if (typeof result === 'string') return cap(result);
  const content = result.content || result;
  if (Array.isArray(content)) {
    return cap(content.map(b => (b && b.type === 'text' ? b.text : '')).join('\n').trim());
  }
  if (typeof content === 'string') return cap(content);
  return cap(JSON.stringify(result));
}
