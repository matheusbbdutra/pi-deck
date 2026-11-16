// @vitest-environment jsdom
/* Testes de UI (vitest + jsdom).
 *
 * `ui/src/main.js` é um módulo de efeitos colaterais: no topo liga handlers nos
 * elementos do `index.html` e o bootstrap fala com o Tauri. Para testar as funções
 * puras do transcript o teste carrega o HTML real e um `__TAURI__` falso antes do
 * import. `terminal.js` (xterm exige canvas/ResizeObserver) e `highlight.js`
 * (Prism) não têm relação com a fila de mensagens e ficam fora.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../ui/src/terminal.js', () => ({ initTerminal: () => {}, reconcileTerminal: () => {} }));
vi.mock('../ui/src/highlight.js', () => ({ appendHighlighted: () => {}, langFor: () => null }));

let insertRowByAt;
let shouldRestoreLocalRow;

function row(at, text) {
  const node = document.createElement('div');
  node.className = 'row user';
  node.dataset.text = text;
  if (at !== undefined) node.dataset.at = String(at);
  node.textContent = text;
  return node;
}

function texts(log) {
  return Array.from(log.children).map(n => n.dataset.text);
}

beforeAll(async () => {
  // O ambiente jsdom não dá `import.meta.url` de arquivo: resolve pelo cwd (raiz do repo).
  const html = readFileSync(resolve(process.cwd(), 'ui/index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'));
  vi.stubGlobal('__TAURI__', {
    core: { invoke: async () => { throw new Error('sem Tauri no teste'); } },
    event: { listen: async () => () => {} },
  });
  ({ insertRowByAt, shouldRestoreLocalRow } = await import('../ui/src/main.js'));
});

describe('insertRowByAt', () => {
  it('insere no meio, antes da primeira row mais nova', () => {
    const log = document.createElement('div');
    log.append(row(100, 'a'), row(200, 'b'), row(300, 'c'));
    const local = row(250, 'local');
    insertRowByAt(log, local, 250);
    expect(texts(log)).toEqual(['a', 'b', 'local', 'c']);
  });

  it('insere no fim quando todas as rows são mais antigas', () => {
    const log = document.createElement('div');
    log.append(row(100, 'a'), row(200, 'b'));
    const local = row(900, 'local');
    insertRowByAt(log, local, 900);
    expect(texts(log)).toEqual(['a', 'b', 'local']);
  });

  it('insere no início quando todas as rows são mais novas', () => {
    const log = document.createElement('div');
    log.append(row(100, 'a'), row(200, 'b'));
    const local = row(50, 'local');
    insertRowByAt(log, local, 50);
    expect(texts(log)).toEqual(['local', 'a', 'b']);
  });

  it('ignora rows sem âncora cronológica e cai no fim quando `at` é desconhecido', () => {
    const log = document.createElement('div');
    log.append(row(undefined, 'sem-at'), row(100, 'a'));
    const local = row(undefined, 'local');
    insertRowByAt(log, local, undefined);
    expect(texts(log)).toEqual(['sem-at', 'a', 'local']);
  });
});

describe('shouldRestoreLocalRow', () => {
  it('não reinsere linha cujo texto já está no transcript', () => {
    const seen = new Set(['oi']);
    expect(shouldRestoreLocalRow({ text: 'oi', state: 'delivered' }, seen)).toBe(false);
  });

  it('não reinsere linha cancelada cujo texto já está no transcript', () => {
    const seen = new Set(['prompt da run 1']);
    expect(shouldRestoreLocalRow({ text: 'prompt da run 1', state: 'cancelled' }, seen)).toBe(false);
  });

  it('reinsere linha que o disco ainda não tem', () => {
    const seen = new Set(['outra mensagem']);
    expect(shouldRestoreLocalRow({ text: 'prompt novo', state: 'pending' }, seen)).toBe(true);
    expect(shouldRestoreLocalRow({ text: 'fila morreu', state: 'cancelled' }, seen)).toBe(true);
  });
});
