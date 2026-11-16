import { inv } from './rpc.js';
import { $, el, clear, stripAnsi, scrollBottom } from './shared.js';

/* =============== markdown (DOM puro, sem innerHTML) =============== */
function inline(text) {
  const frag = document.createDocumentFragment();
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s)]+)/g;
  let last = 0, m;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    const tok = m[0];

    if (tok.startsWith('`')) {
      frag.appendChild(el('code', null, tok.slice(1, -1)));
    } else if (tok.startsWith('**')) {
      const b = el('strong');
      b.appendChild(inline(tok.slice(2, -2)));
      frag.appendChild(b);
    } else if (tok.startsWith('[')) {
      const parts = tok.match(/\[([^\]]+)\]\(([^)\s]+)\)/);
      const url = parts[2];
      // Só http(s) vira link: javascript:/data:/file: viram texto (XSS via href).
      if (!/^https?:\/\//i.test(url)) { frag.appendChild(document.createTextNode(tok)); }
      else {
        const a = el('a', null, parts[1]);
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        // Nunca navega o webview: abre no navegador via backend (que valida http(s)).
        a.onclick = (e) => { e.preventDefault(); inv('open_external', { url }).catch(() => {}); };
        frag.appendChild(a);
      }
    } else if (tok.startsWith('http')) {
      const a = el('a', null, tok);
      a.href = tok;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.onclick = (e) => { e.preventDefault(); inv('open_external', { url: tok }).catch(() => {}); };
      frag.appendChild(a);
    } else if (tok.startsWith('*')) {
      const em = el('em');
      em.appendChild(inline(tok.slice(1, -1)));
      frag.appendChild(em);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map(c => c.trim());
}

function buildTable(header, rows) {
  const wrap = el('div', 'scroll-x');
  const table = el('table', 'md-table');
  const thead = el('thead');
  const htr = el('tr');
  for (const h of header) {
    const th = el('th');
    th.appendChild(inline(h));
    htr.appendChild(th);
  }
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = el('tbody');
  for (const r of rows) {
    const tr = el('tr');
    for (let c = 0; c < header.length; c++) {
      const td = el('td');
      td.appendChild(inline(r[c] === undefined ? '' : r[c]));
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function codeBox(lang, code) {
  const box = el('div', 'md-code-box');
  if (lang) box.appendChild(el('div', 'md-code-lang', lang));
  // Copiar o bloco cru (sem a cerca ``` e sem o rótulo da linguagem).
  const btn = el('button', 'copybtn code-copy', 'copiar');
  btn.type = 'button';
  btn.title = 'Copiar este bloco';
  btn.onclick = () => copyText(btn, code);
  box.appendChild(btn);
  const wrap = el('div', 'scroll-x');
  const pre = el('pre');
  pre.appendChild(el('code', null, code));
  wrap.appendChild(pre);
  box.appendChild(wrap);
  return box;
}

const isTableRow = (s) => /^\s*\|.*\|\s*$/.test(s);
const isTableSep = (s) => /^\s*\|[\s:|-]+\|\s*$/.test(s);
const isBlockStart = (s) =>
  /^\s*```/.test(s) || /^\s*#{1,6}\s/.test(s) || /^\s*>/.test(s) ||
  /^\s*[-*+]\s+/.test(s) || /^\s*\d+\.\s+/.test(s) || /^\s*(-{3,}|\*{3,})\s*$/.test(s) ||
  isTableRow(s);

export function renderMarkdown(target, md) {
  clear(target);
  const lines = md.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    // cerca de código
    if (/^\s*```/.test(line)) {
      const lang = line.replace(/^\s*```/, '').trim();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      target.appendChild(codeBox(lang, buf.join('\n')));
      continue;
    }

    // tabela
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const header = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && isTableRow(lines[i])) { rows.push(splitRow(lines[i])); i++; }
      target.appendChild(buildTable(header, rows));
      continue;
    }

    // titulo
    const h = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (h) {
      const tag = 'h' + h[1].length;
      const node = el(tag);
      node.appendChild(inline(h[2]));
      target.appendChild(node);
      i++;
      continue;
    }

    // regra
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { target.appendChild(el('hr')); i++; continue; }

    // citacao
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      const bq = el('blockquote');
      bq.appendChild(inline(buf.join(' ')));
      target.appendChild(bq);
      continue;
    }

    // listas
    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const list = el(ordered ? 'ol' : 'ul');
      const re = ordered ? /^\s*\d+\.\s+/ : /^\s*[-*+]\s+/;
      while (i < lines.length && re.test(lines[i])) {
        const item = el('li');
        item.appendChild(inline(lines[i].replace(re, '')));
        list.appendChild(item);
        i++;
      }
      target.appendChild(list);
      continue;
    }

    // paragrafo
    const buf = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      buf.push(lines[i]);
      i++;
    }

    // Linha que "parece bloco" mas não casou nenhum caso acima (ex.: `| a | b |`
    // sem a linha separadora). Sem isto o laço não avança — loop infinito.
    if (!buf.length) {
      const solo = el('p');
      solo.appendChild(inline(lines[i]));
      target.appendChild(solo);
      i++;
      continue;
    }

    const p = el('p');
    buf.forEach((t, idx) => {
      if (idx) p.appendChild(el('br'));
      p.appendChild(inline(t));
    });
    target.appendChild(p);
  }
}

export function setMarkdown(node, md) {
  node.classList.add('md');
  // Fonte crua para o botão "copiar": o DOM perde a sintaxe markdown.
  node._md = md;
  renderMarkdown(node, md);
}

/** Resposta formatada com botão de copiar (copia o markdown original). */
export function mdRow() {
  const root = el('div', 'row md');
  const body = el('div', 'md-body');
  const btn = el('button', 'copybtn', 'copiar');
  btn.type = 'button';
  btn.title = 'Copiar esta mensagem';
  btn.onclick = () => copyText(btn, body._md || body.textContent);
  root.append(body, btn);
  return { root, body, btn };
}

/** Copia pelo utilitário do sistema (o webview da WebKitGTK não expõe a API nova). */
export async function copyText(btn, text) {
  if (!text) return;
  const label = btn.textContent;
  try {
    await inv('copy_text', { text });
    btn.textContent = 'copiado';
    btn.classList.add('ok');
  } catch {
    btn.textContent = 'falhou';
  }
  setTimeout(() => {
    btn.textContent = label;
    btn.classList.remove('ok');
  }, 1200);
}

/* Atividade de extensões: status/notify ao vivo (dedup por statusKey). */
const extNodes = new Map();

export function extActivity(text, key) {
  if (!text) return;
  const existing = key ? extNodes.get(key) : null;
  if (existing) {
    const span = existing.querySelector('span');
    if (span) span.textContent = ' ' + stripAnsi(text);
    return;
  }
  const row = el('div', 'row ext');
  row.appendChild(el('b', null, 'extensão'));
  row.appendChild(el('span', null, ' ' + stripAnsi(text)));
  $('log').appendChild(row);
  if (key) extNodes.set(key, row);
  scrollBottom();
}
