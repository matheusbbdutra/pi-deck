import { $, el, scrollBottom, uiSettings, cards } from './shared.js';

/* =============== tool cards =============== */
function summarize(name, args) {
  if (!args) return '';
  const a = args.args || args;
  if (name === 'bash') return '$ ' + (a.command || '');
  if (a.path || a.file_path) return String(a.path || a.file_path).replace(/^.*\/(?=[^/]+$)/, '');
  if (a.pattern) return '/' + a.pattern + '/';
  if (a.agent) return a.agent + (a.task ? ' · ' + a.task : '');
  if (a.query) return a.query;
  if (a.url) return a.url;
  const k = Object.keys(a)[0];
  return k ? k + '=' + String(a[k]).slice(0, 60) : '';
}

function nowTime(ms) {
  const d = ms ? new Date(ms) : new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
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

  const body = el('pre', 'tool-body');
  root.append(head, body);
  head.addEventListener('click', () => root.classList.toggle('collapsed'));

  if (!uiSettings.expandTools) root.classList.add('collapsed');

  target.appendChild(root);
  if (!ctx) scrollBottom();

  const entry = { root, body, icon, time };
  if (callId) store.set(callId, entry);
  return entry;
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
