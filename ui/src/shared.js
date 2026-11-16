export const uiSettings = { expandTools: false, expandThink: false, showHidden: false, notifyDesktop: true, notifySound: true };
export const caps = { subagents: null };
export const cards = new Map();
/* Linha do transcript esperando a resposta do prompt (para marcar "na fila"). */
export const pendingPromptRows = new Map();

export const $ = (id) => document.getElementById(id);

export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
/* PTY: o backend trafega bytes em base64; o xterm escreve Uint8Array. */
export function b64FromBytes(bytes) {
  let bin = '';
  // fatiado: String.fromCharCode.apply estoura a pilha em blocos grandes de saída do shell
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function bytesFromB64(b64) {
  const bin = atob(String(b64 == null ? '' : b64));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* pi manda ANSI em setStatus/notify (cores de terminal); o log é texto puro. */
export const stripAnsi = (s) => String(s == null ? '' : s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
export function setEmpty(node, text, cls) { clear(node); node.appendChild(el('div', cls || 'empty', text)); }
export function scrollBottom(force) {
  const l = $('log');
  if (!l) return;
  const away = l.scrollHeight - l.scrollTop - l.clientHeight;
  // Ao abrir/re-renderizar, sempre vai ao fim. Durante o stream, só se você já estava no fim.
  if (!force && away > 260) {
    $('scrollbottom').classList.remove('hidden');
    return;
  }
  l.scrollTop = l.scrollHeight;
  updateScrollBtn();
}

export function updateScrollBtn() {
  const l = $('log');
  const btn = $('scrollbottom');
  if (!l || !btn) return;
  btn.classList.toggle('hidden', l.scrollHeight - l.scrollTop - l.clientHeight < 220);
}
