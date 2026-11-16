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
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { THEME_KEYS, applyTheme, resetTheme, validateTheme } from '../ui/src/theme.js';

vi.mock('../ui/src/terminal.js', () => ({ initTerminal: () => {}, reconcileTerminal: () => {} }));
vi.mock('../ui/src/highlight.js', () => ({ appendHighlighted: () => {}, langFor: () => null }));

let insertRowByAt;
let shouldRestoreLocalRow;
let appendCapped;
let setZoom;
let shouldProbeTurn;

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
  ({ insertRowByAt, shouldRestoreLocalRow, appendCapped, setZoom, shouldProbeTurn } = await import('../ui/src/main.js'));
});

describe('appendCapped', () => {
  it('acumula o delta no parcial da aba', () => {
    expect(appendCapped('pensando', ' mais', 1000)).toBe('pensando mais');
    expect(appendCapped('', 'a', 10)).toBe('a');
    expect(appendCapped(undefined, 'b', 10)).toBe('b');
  });

  it('respeita o cap mantendo os últimos caracteres', () => {
    expect(appendCapped('abc', 'def', 4)).toBe('cdef');
    expect(appendCapped('12345', '', 3)).toBe('345');
    expect(appendCapped('123', '', 3)).toBe('123');
  });

  it('não corta emoji ao meio quando o cap cai no par substituto', () => {
    // O corte por unidade UTF-16 deixaria só a metade baixa do par.
    expect(appendCapped('🙂', 'x', 2)).toBe('x');
    const out = appendCapped('a🙂b', '🙂', 2);
    expect(out).toBe('🙂');
    expect(/^[\udc00-\udfff]/.test(out)).toBe(false);
    expect(/[\ud800-\udbff]$/.test(out)).toBe(false);
  });

  it('mantém acento intacto no limite', () => {
    expect(appendCapped('', 'ção', 2)).toBe('ão');
  });
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

describe('setZoom', () => {
  it('clampa no mínimo 0.6 e persiste o valor aplicado', () => {
    expect(setZoom(0.2)).toBe(0.6);
    expect(localStorage.getItem('zoom')).toBe('0.6');
  });

  it('clampa no máximo 2.0 e persiste o valor aplicado', () => {
    expect(setZoom(5)).toBe(2);
    expect(localStorage.getItem('zoom')).toBe('2');
  });

  it('arredonda o passo de 0.1 (0.6 + 0.1 = 0.7) e persiste', () => {
    expect(setZoom(0.6 + 0.1)).toBe(0.7);
    expect(localStorage.getItem('zoom')).toBe('0.7');
  });

  it('reset volta a 1.0', () => {
    setZoom(1.7);
    expect(setZoom(1)).toBe(1);
    expect(localStorage.getItem('zoom')).toBe('1');
  });
});

describe('shouldProbeTurn', () => {
  const base = { silenceMs: 45000, probeIntervalMs: 30000 };

  it('não sonda antes do silêncio', () => {
    // 44s de silêncio: ainda dentro da janela, o turno pode estar só demorando.
    expect(shouldProbeTurn({ ...base, working: true, lastEventAt: 1000, now: 45000 })).toBe(false);
  });

  it('sonda depois do silêncio', () => {
    expect(shouldProbeTurn({ ...base, working: true, lastEventAt: 1000, now: 46001 })).toBe(true);
  });

  it('não sonda de novo antes do intervalo mínimo entre sondas', () => {
    const silenceOver = { ...base, working: true, lastEventAt: 0, now: 60000 };
    expect(shouldProbeTurn({ ...silenceOver, lastProbeAt: 40000 })).toBe(false);
    expect(shouldProbeTurn({ ...silenceOver, lastProbeAt: 30000 })).toBe(true);
  });

  it('não sonda aba que não está trabalhando', () => {
    expect(shouldProbeTurn({ ...base, working: false, lastEventAt: 0, now: 600000 })).toBe(false);
  });

  it('aba sem evento registrado conta como silenciosa desde sempre', () => {
    expect(shouldProbeTurn({ ...base, working: true, lastEventAt: undefined, now: 46000 })).toBe(true);
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

describe('tema por JSON', () => {
  afterEach(() => {
    resetTheme();
    localStorage.clear();
  });

  it('THEME_KEYS tem os 46 tokens do :root, sem --mono', () => {
    expect(THEME_KEYS.length).toBe(46);
    expect(new Set(THEME_KEYS).size).toBe(46);
    expect(THEME_KEYS).not.toContain('mono');
  });

  it('aceita chave conhecida com cor válida (com ou sem prefixo --)', () => {
    expect(validateTheme({ bg: '#0f1115' })).toEqual({ ok: { bg: '#0f1115' }, ignored: [] });
    expect(validateTheme({ '--accent': 'rgb(122 162 247)' }).ok).toEqual({ accent: 'rgb(122 162 247)' });
    expect(validateTheme({ 'ink-0': 'hsla(0,0%,100%,.9)' }).ok).toEqual({ 'ink-0': 'hsla(0,0%,100%,.9)' });
    expect(validateTheme({ ok: '#7ee78780' }).ok).toEqual({ ok: '#7ee78780' });
  });

  it('ignora chave desconhecida', () => {
    const res = validateTheme({ 'mono': 'Comic Sans', 'bg-9': '#fff', bg: '#fff' });
    expect(res.ok).toEqual({ bg: '#fff' });
    expect(res.ignored).toEqual(['mono', 'bg-9']);
  });

  it('ignora valor que não é cor', () => {
    const res = validateTheme({ bg: 'url(http://x/a.png)', panel: 123, card: '', fg: 'expression(alert(1))' });
    expect(res.ok).toEqual({});
    expect(res.ignored).toEqual(['bg', 'panel', 'card', 'fg']);
  });

  it('string JSON inválida não lança e devolve error', () => {
    expect(() => validateTheme('{ nope')).not.toThrow();
    const res = validateTheme('{ nope');
    expect(res.ok).toEqual({});
    expect(res.ignored).toEqual([]);
    expect(res.error).toMatch(/JSON inválido/);
    expect(validateTheme('').error).toBe('JSON vazio');
    expect(validateTheme('[1,2]').error).toMatch(/objeto/);
  });

  it('applyTheme chama setProperty só para chaves conhecidas e persiste', () => {
    const spy = vi.spyOn(document.documentElement.style, 'setProperty');
    const res = applyTheme({ bg: '#101010', accent: 'hsl(210 80% 70%)', nope: '#fff', panel: 42 });
    expect(spy.mock.calls.map(c => c[0])).toEqual(['--bg', '--accent']);
    spy.mockRestore();
    expect(res.ignored).toEqual(['nope', 'panel']);
    expect(JSON.parse(localStorage.getItem('theme'))).toEqual({ bg: '#101010', accent: 'hsl(210 80% 70%)' });
    resetTheme();
    expect(localStorage.getItem('theme')).toBe(null);
    expect(document.documentElement.style.getPropertyValue('--bg')).toBe('');
  });
});
