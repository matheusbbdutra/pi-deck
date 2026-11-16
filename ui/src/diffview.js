/* =============== vista do diff: unificada (default) | split =============== */

/** Preferência persistida; sem storage (teste em Node) a vista unificada vale. */
const VIEW_KEY = 'diff-view';

export function diffView() {
  try { return localStorage.getItem(VIEW_KEY) === 'split' ? 'split' : 'unified'; }
  catch { return 'unified'; }
}

export function setDiffView(view) {
  try { localStorage.setItem(VIEW_KEY, view === 'split' ? 'split' : 'unified'); }
  catch { /* sem storage: a troca vale só até o próximo render */ }
}

/**
 * Linhas de UM hunk unificado (incluindo o `@@`) → linhas pareadas da vista split.
 * O `@@` vira `{ hunk: text }` sozinho; o resto vira `{ left, right }` com células
 * `{ kind:'ctx'|'del'|'add'|'pad', text }`. Remoções e adições são pareadas na
 * ordem (1ª com 1ª, ...) e o lado que acabar vira `pad` (célula vazia). O texto da
 * célula mantém o prefixo (`-`, `+`, ` `), então a linha é reconstruível.
 */
export function splitHunk(lines) {
  const rows = [];
  let dels = [];
  let adds = [];
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) {
      rows.push({
        left: i < dels.length ? { kind: 'del', text: dels[i] } : { kind: 'pad', text: '' },
        right: i < adds.length ? { kind: 'add', text: adds[i] } : { kind: 'pad', text: '' },
      });
    }
    dels = [];
    adds = [];
  };
  for (const line of lines || []) {
    if (line.startsWith('@@')) { flush(); rows.push({ hunk: line }); continue; }
    if (line.startsWith('-')) { dels.push(line); continue; }
    if (line.startsWith('+')) { adds.push(line); continue; }
    flush();
    rows.push({ left: { kind: 'ctx', text: line }, right: { kind: 'ctx', text: line } });
  }
  flush();
  return rows;
}
