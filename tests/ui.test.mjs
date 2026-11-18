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
import { t, getLang, getLangPref, setLang, detectLang, applyStaticI18n, STRINGS } from '../ui/src/i18n.js';

vi.mock('../ui/src/terminal.js', () => ({ initTerminal: () => {}, reconcileTerminal: () => {} }));
vi.mock('../ui/src/highlight.js', () => ({ appendHighlighted: () => {}, langFor: () => null }));

let insertRowByAt;
let shouldRestoreLocalRow;
let appendCapped;
let logHasText;
let setZoom;
let shouldProbeTurn;
let shouldAbortOnEsc;
let clampWidth;
let clampColumns;
let syncStopButton;
let classifyHealthLine;
let noteHealth;
let healthChipState;
let renderHealthList;
let muteHealth;
let unmuteHealth;
let normalizeRowText;
let answerAlreadyRendered;
let isLiveRun;
let elapsedFor;
let reattachPlan;
let renderSubs;
let renderedAnswerNode;
let estimateMessageTokens;
let liveTurnTokens;
let liveStatsView;

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
  localStorage.setItem('lang', 'pt');
  vi.stubGlobal('__TAURI__', {
    core: { invoke: async () => { throw new Error('sem Tauri no teste'); } },
    event: { listen: async () => () => {} },
  });
  ({ insertRowByAt, shouldRestoreLocalRow, appendCapped, logHasText, setZoom, shouldProbeTurn, shouldAbortOnEsc,
     clampWidth, clampColumns, syncStopButton, classifyHealthLine, noteHealth,
     healthChipState, renderHealthList, muteHealth, unmuteHealth, normalizeRowText, answerAlreadyRendered, isLiveRun, elapsedFor,
     renderSubs, renderedAnswerNode, reattachPlan, estimateMessageTokens, liveTurnTokens,
     liveStatsView } = await import('../ui/src/main.js'));
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

describe('logHasText', () => {
  it('reconhece o texto já pintado pelo histórico e ignora o resto', () => {
    const log = document.getElementById('log');
    log.innerHTML = '';
    const body = document.createElement('div');
    body.className = 'md-body';
    const full = 'SIM — validada antes do fan-out:\n\n· subagent({action:list}) — único agente executável';
    body._md = full;
    log.appendChild(body);
    expect(logHasText(full)).toBe(true);
    // Parcial cortado pelo cap é um sufixo do texto completo: continua reconhecido.
    expect(logHasText('x'.repeat(200) + '\n' + full.slice(-80))).toBe(false);
    expect(logHasText(full.slice(-40))).toBe(true);
    expect(logHasText('outra resposta')).toBe(false);
    expect(logHasText('')).toBe(false);
    log.innerHTML = '';
  });

  it('ignora texto de turno anterior e normaliza espaços', () => {
    const log = document.getElementById('log');
    log.innerHTML = '';
    const oldUser = document.createElement('div');
    oldUser.className = 'row user';
    const old = document.createElement('div');
    old.className = 'md-body';
    old._md = 'Feito.';
    const curUser = document.createElement('div');
    curUser.className = 'row user';
    log.append(oldUser, old, curUser);
    // Resposta do turno anterior não pode zerar o parcial do turno atual.
    expect(logHasText('Feito.')).toBe(false);
    const cur = document.createElement('div');
    cur.className = 'md-body';
    cur._md = 'Feito.';
    log.appendChild(cur);
    expect(logHasText('  Feito.  \n')).toBe(true);
    log.innerHTML = '';
  });
});

describe('i18n (pt/en)', () => {
  // O `beforeAll` global fixa 'lang' em pt; captura aqui (roda depois dele) e restaura.
  let saved = null;
  let savedHtmlLang = '';
  beforeAll(() => {
    saved = localStorage.getItem('lang');
    savedHtmlLang = document.documentElement.lang;
  });

  afterEach(() => {
    if (saved === null) localStorage.removeItem('lang');
    else localStorage.setItem('lang', saved);
    document.documentElement.lang = savedHtmlLang;
  });

  // Override só na instância: `delete` volta ao getter do Navigator.prototype.
  const withNavigatorLang = (value, fn) => {
    Object.defineProperty(window.navigator, 'language', { value, configurable: true });
    try { return fn(); } finally { delete window.navigator.language; }
  };

  it('detecta pt-* como pt e o resto como en', () => {
    withNavigatorLang('pt-BR', () => expect(detectLang()).toBe('pt'));
    withNavigatorLang('en-GB', () => expect(detectLang()).toBe('en'));
    withNavigatorLang('fr-FR', () => expect(detectLang()).toBe('en'));
  });

  it('preferência salva manda; auto usa o navigator e valor inválido cai em auto', () => {
    localStorage.setItem('lang', 'pt');
    expect(getLang()).toBe('pt');
    expect(getLangPref()).toBe('pt');
    localStorage.setItem('lang', 'auto');
    withNavigatorLang('pt-BR', () => expect(getLang()).toBe('pt'));
    expect(getLangPref()).toBe('auto');
    localStorage.setItem('lang', 'de');
    expect(getLangPref()).toBe('auto');
  });

  it('setLang persiste, aplica o <html lang> e devolve o idioma efetivo', () => {
    expect(setLang('en')).toBe('en');
    expect(localStorage.getItem('lang')).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    expect(setLang('pt')).toBe('pt');
    expect(document.documentElement.lang).toBe('pt-BR');
    withNavigatorLang('en-GB', () => expect(setLang('xx')).toBe('en'));
    expect(localStorage.getItem('lang')).toBe('auto');
  });

  it('traduz nos dois idiomas e devolve a própria chave quando ela não existe', () => {
    setLang('pt');
    expect(t('composer.send')).toBe('Enviar (Enter)');
    setLang('en');
    expect(t('composer.send')).toBe('Send (Enter)');
    expect(t('chave.inexistente')).toBe('chave.inexistente');
  });

  it('applyStaticI18n aplica placeholder e não sobrescreve estado vivo', () => {
    setLang('en');
    // `status` e `#send.title` pertencem ao runtime (setStatus/syncStopButton).
    document.getElementById('status').textContent = 'conectado · s1';
    document.getElementById('send').title = 'Enfileirar mensagem (turno rodando)';
    applyStaticI18n();
    expect(document.getElementById('input').placeholder).toBe(t('composer.placeholder'));
    expect(document.getElementById('status').textContent).toBe('conectado · s1');
    expect(document.getElementById('send').title).toBe('Enfileirar mensagem (turno rodando)');
  });

  it('getLang ignora valor inválido salvo e cai na detecção', () => {
    localStorage.setItem('lang', 'de');
    withNavigatorLang('en-GB', () => expect(getLang()).toBe('en'));
  });

  it('pt e en têm exatamente as mesmas chaves', () => {
    expect(Object.keys(STRINGS.en).sort()).toEqual(Object.keys(STRINGS.pt).sort());
  });

  it('o seletor de idioma declara auto/pt/en', () => {
    const sel = document.getElementById('langsel');
    expect(Array.from(sel.options).map(o => o.value)).toEqual(['auto', 'pt', 'en']);
  });
});

describe('classifyHealthLine', () => {
  it('reconhece o aviso real de LSP inativo', () => {
    expect(classifyHealthLine('extensão LSP inactive')).toEqual({ kind: 'lsp', id: 'extensão LSP inactive' });
  });

  it('reconhece o aviso real de MCP precisando de atenção', () => {
    const line = 'extensão MCP servers need attention: browseros-neo: failed: fetch failed Run /mcp to fix';
    expect(classifyHealthLine(line)).toEqual({ kind: 'mcp', id: line });
  });

  it('devolve null para linha normal do protocolo e para entrada vazia', () => {
    expect(classifyHealthLine('{"type":"agent_settled"}')).toBe(null);
    expect(classifyHealthLine('turno pronto')).toBe(null);
    expect(classifyHealthLine('')).toBe(null);
    expect(classifyHealthLine(null)).toBe(null);
  });

  it('casa com ANSI e prefixo de data/hora, que não entram no id', () => {
    expect(classifyHealthLine('\u001b[33m2026-01-02T10:00:00Z extensão LSP inactive\u001b[0m'))
      .toEqual({ kind: 'lsp', id: 'extensão LSP inactive' });
    expect(classifyHealthLine('[12:00:01] extensão MCP servers need attention: x'))
      .toEqual({ kind: 'mcp', id: 'extensão MCP servers need attention: x' });
  });

  it('id deduplica a mesma mensagem com espaçamento diferente', () => {
    const a = classifyHealthLine('extensão LSP inactive');
    const b = classifyHealthLine('  extensão   LSP  inactive  ');
    expect(b.id).toBe(a.id);
    expect(b.kind).toBe('lsp');
  });

  it('lê o aviso que chega como notify de extensão no JSON', () => {
    const line = JSON.stringify({ type: 'extension_ui_request', id: 'e1', method: 'notify', message: 'LSP inactive' });
    expect(classifyHealthLine(line)).toEqual({ kind: 'lsp', id: 'LSP inactive' });
    const mcp = JSON.stringify({ type: 'extension_ui_request', method: 'notify', message: 'MCP servers need attention: browseros-neo: failed: fetch failed' });
    expect(classifyHealthLine(mcp).kind).toBe('mcp');
  });

  it('não casa texto de aviso dentro de registro que não é notify de extensão', () => {
    const tool = JSON.stringify({ type: 'tool_execution_end', result: { output: 'MCP servers need attention: x failed' } });
    expect(classifyHealthLine(tool)).toBe(null);
    const delta = JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'LSP inactive' } });
    expect(classifyHealthLine(delta)).toBe(null);
  });
});

describe('noteHealth / healthChipState', () => {
  const add = (map, ...lines) => lines.forEach(l => noteHealth(map, l));

  it('mapa vazio (ou sem mapa) devolve chip sem avisos', () => {
    expect(healthChipState(new Map())).toEqual({ count: 0, kinds: [], title: '' });
    expect(healthChipState(undefined)).toEqual({ count: 0, kinds: [], title: '' });
  });

  it('um aviso: conta 1, guarda o tipo e lista a mensagem no title', () => {
    const map = new Map();
    add(map, 'extensão LSP inactive');
    const st = healthChipState(map);
    expect(st.count).toBe(1);
    expect(st.kinds).toEqual(['lsp']);
    expect(st.title).toMatch(/1 aviso\(s\)/);
    expect(st.title).toMatch(/lsp: extensão LSP inactive/);
  });

  it('três avisos (tipos misturados): kinds na ordem de chegada e 3 linhas no title', () => {
    const map = new Map();
    add(map,
      'extensão LSP inactive',
      'extensão MCP servers need attention: browseros-neo: failed: fetch failed',
      'extensão LSP inactive (2)');
    const st = healthChipState(map);
    expect(st.count).toBe(3);
    expect(st.kinds).toEqual(['lsp', 'mcp']);
    expect(st.title.split('\n').length).toBe(4); // cabeçalho + 3 mensagens
    expect(st.title).not.toMatch(/…/);
  });

  it('acima de 3 mensagens resume o resto com … e a contagem', () => {
    const map = new Map();
    add(map,
      'extensão LSP inactive',
      'extensão MCP servers need attention: a',
      'extensão MCP servers need attention: b',
      'extensão MCP servers need attention: c',
      'extensão MCP servers need attention: d');
    const st = healthChipState(map);
    expect(st.count).toBe(5);
    expect(st.title.split('\n').length).toBe(5); // cabeçalho + 3 + resumo
    expect(st.title).toMatch(/… \+2 aviso\(s\)/);
  });

  it('deduplica mensagem repetida com espaços diferentes', () => {
    const map = new Map();
    add(map, 'extensão LSP inactive', '  extensão   LSP  inactive ');
    expect(map.size).toBe(1);
    expect(healthChipState(map).count).toBe(1);
  });

  it('limita a 20 avisos por sessão descartando o mais antigo', () => {
    const map = new Map();
    for (let i = 0; i < 25; i++) noteHealth(map, 'extensão LSP inactive #' + i);
    expect(map.size).toBe(20);
    expect(map.has('extensão LSP inactive #0')).toBe(false);
    expect(map.has('extensão LSP inactive #24')).toBe(true);
    expect(healthChipState(map).count).toBe(20);
  });

  it('ignora linha não reconhecida sem criar entrada', () => {
    const map = new Map();
    expect(noteHealth(map, 'turno pronto')).toBe(null);
    expect(map.size).toBe(0);
  });

  it('aviso dispensado não conta nem entra no mapa, e volta ao restaurar', () => {
    const map = new Map();
    muteHealth('extensão LSP inactive');
    expect(noteHealth(map, 'extensão LSP inactive')).toBe(null);
    expect(map.size).toBe(0);
    unmuteHealth();
    expect(noteHealth(map, 'extensão LSP inactive')).toBe('lsp');
    expect(map.size).toBe(1);
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

describe('clampWidth', () => {
  it('sobe para o mínimo', () => {
    expect(clampWidth(100, 180, 520)).toBe(180);
  });

  it('desce para o máximo', () => {
    expect(clampWidth(900, 180, 520)).toBe(520);
  });

  it('mantém valor dentro da faixa e trata lixo como mínimo', () => {
    expect(clampWidth(300, 180, 520)).toBe(300);
    expect(clampWidth('310', 180, 520)).toBe(310);
    expect(clampWidth(NaN, 180, 520)).toBe(180);
    expect(clampWidth(undefined, 240, 720)).toBe(240);
  });
});

describe('clampColumns', () => {
  it('não mexe quando o centro cabe', () => {
    expect(clampColumns(300, 340, 1400)).toEqual({ aside: 300, panel: 340 });
  });

  it('reduz as colunas para preservar 320px de centro', () => {
    const fit = clampColumns(520, 720, 1000);
    expect(fit.aside + fit.panel).toBeLessThanOrEqual(1000 - 320);
    expect(fit.aside).toBeGreaterThanOrEqual(180);
    expect(fit.panel).toBeGreaterThanOrEqual(240);
  });

  it('reduz mais a coluna que estourou (a outra fica no piso)', () => {
    const fit = clampColumns(180, 720, 1000);
    expect(fit.aside).toBe(180);
    expect(fit.panel).toBe(1000 - 320 - 180);
  });

  it('não desce abaixo dos pisos quando nem os pisos cabem', () => {
    expect(clampColumns(520, 720, 640)).toEqual({ aside: 180, panel: 240 });
  });
});

describe('grip do composer: Ctrl+wheel', () => {
  const card = () => document.querySelector('.composer-card');
  const wheel = (init) => new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
  const varPx = () => parseFloat(document.body.style.getPropertyValue('--composer-w'));

  it('sem Ctrl não intercepta nem persiste', () => {
    const ev = wheel({ deltaY: -1 });
    card().dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(Number.isNaN(varPx())).toBe(true);
    expect(localStorage.getItem('composer-w')).toBe(null);
  });

  it('com Ctrl alarga 40px por passo e persiste', () => {
    card().dispatchEvent(wheel({ ctrlKey: true, deltaY: -1 }));
    expect(varPx()).toBe(860);
    expect(localStorage.getItem('composer-w')).toBe('860');
    const ev = wheel({ ctrlKey: true, deltaY: -1 });
    card().dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(varPx()).toBe(900);
  });

  it('com Ctrl encolhe 40px por passo até o piso de 520', () => {
    for (let i = 0; i < 40; i++) card().dispatchEvent(wheel({ ctrlKey: true, deltaY: 1 }));
    expect(varPx()).toBe(520);
    expect(localStorage.getItem('composer-w')).toBe('520');
  });

  it('com Ctrl alarga até o teto de 1600', () => {
    for (let i = 0; i < 40; i++) card().dispatchEvent(wheel({ ctrlKey: true, deltaY: -1 }));
    expect(varPx()).toBe(1600);
    expect(localStorage.getItem('composer-w')).toBe('1600');
  });
});

describe('colunas laterais: Ctrl + arrastar', () => {
  const gripAside = () => document.getElementById('colgripaside');
  const pointer = (type, init) => gripAside().dispatchEvent(
    new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }));
  const varPx = (name) => parseFloat(document.body.style.getPropertyValue(name));

  it('sem Ctrl o grip não captura e não mexe na largura', () => {
    pointer('pointerdown', { clientX: 100 });
    pointer('pointermove', { clientX: 200 });
    expect(Number.isNaN(varPx('--w-aside'))).toBe(true);
    expect(localStorage.getItem('w-aside')).toBe(null);
  });

  it('com Ctrl arrasta em px, preserva o centro e só persiste ao soltar', () => {
    pointer('pointerdown', { clientX: 100, ctrlKey: true });
    pointer('pointermove', { clientX: 200, ctrlKey: true });
    // 320 (partida sem layout medido) + 100 pedidos; o clamp devolve o que cabe
    // na janela de 1024px com 320px de centro: 380 + 323.
    expect(varPx('--w-aside')).toBe(380);
    expect(varPx('--w-panel')).toBe(323);
    expect(localStorage.getItem('w-aside')).toBe(null);
    pointer('pointerup', { clientX: 200, ctrlKey: true });
    expect(localStorage.getItem('w-aside')).toBe('380');
    expect(localStorage.getItem('w-panel')).toBe('323');
  });

  it('com zoom 2.0 o resize reaplica os pisos (sem largura fixa estourando)', () => {
    setZoom(2);
    window.dispatchEvent(new Event('resize'));
    // 1024/2 = 512px úteis: nem os pisos cabem com 320px de centro, então as
    // colunas ficam no piso e o `minmax(220px,…)` do CSS continua mandando.
    expect(varPx('--w-aside')).toBe(180);
    expect(varPx('--w-panel')).toBe(240);
    setZoom(1);
    window.dispatchEvent(new Event('resize'));
    expect(varPx('--w-aside')).toBe(380);
  });
});

describe('syncStopButton', () => {
  const stop = () => document.getElementById('stopbtn');
  const send = () => document.getElementById('send');

  it('turno rodando mostra o parar e mantém o envio clicável (fila)', () => {
    syncStopButton(true);
    expect(stop().classList.contains('hidden')).toBe(false);
    expect(send().disabled).toBe(false);
    expect(send().title).toBe('Enfileirar mensagem (turno rodando)');
  });

  it('turno parado esconde o parar e volta o título de envio', () => {
    syncStopButton(false);
    expect(stop().classList.contains('hidden')).toBe(true);
    expect(send().disabled).toBe(false);
    expect(send().title).toBe('Enviar (Enter)');
  });
});

describe('shouldProbeTurn', () => {  const base = { silenceMs: 45000, probeIntervalMs: 30000 };

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
    localStorage.removeItem('theme');
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

describe('Esc interrompe o turno', () => {
  it('aborta com turno trabalhando e foco no composer', () => {
    expect(shouldAbortOnEsc({ overlayOpen: false, inTerminal: false, working: true })).toBe(true);
  });

  it('não aborta sem turno trabalhando', () => {
    expect(shouldAbortOnEsc({ overlayOpen: false, inTerminal: false, working: false })).toBe(false);
  });

  it('não aborta com overlay aberto (Esc é de fechar)', () => {
    expect(shouldAbortOnEsc({ overlayOpen: true, inTerminal: false, working: true })).toBe(false);
  });

  it('não rouba o Esc do terminal embutido', () => {
    expect(shouldAbortOnEsc({ overlayOpen: false, inTerminal: true, working: true })).toBe(false);
  });
});

describe('layout com zoom', () => {
  it('colunas laterais relativas em vez de espremer o centro', () => {
    const css = readFileSync(resolve(process.cwd(), 'ui/src/styles.css'), 'utf8');
    // Regressão: `300px 1fr 340px` fixos — com zoom a viewport CSS encolhe e o
    // centro sumia (painel direito engolia tudo). Relativas (%/vars) escalam juntas.
    expect(css).toMatch(/--w-aside:\s*24%;\s*--w-panel:\s*27%/);
    expect(css).toMatch(/grid-template-columns:\s*minmax\(220px,\s*var\(--w-aside\)\)\s+minmax\(0,\s*1fr\)\s+minmax\(240px,\s*var\(--w-panel\)\)/);
    expect(css).toMatch(/body\.no-subs\s*\{\s*grid-template-columns:\s*minmax\(220px,\s*var\(--w-aside\)\)\s+minmax\(0,\s*1fr\)/);
    // O painel fechado some de verdade: `#rightpanel` (1,0,0) vence `section` (0,1,2).
    expect(css).toMatch(/body\.no-subs\s+#rightpanel\s*\{\s*display:\s*none/);
  });

  it('abre como caixinha modal no meio, fora do grid', () => {
    const css = readFileSync(resolve(process.cwd(), 'ui/src/styles.css'), 'utf8');
    const html = readFileSync(resolve(process.cwd(), 'ui/index.html'), 'utf8');
    // Regressão: célula do grid ou offsets fixos quebravam com zoom/colunas
    // redimensionadas (virava terceira coluna ou cortava o transcript). Agora é
    // scrim fixo + caixa central, imune ao layout das colunas.
    expect(css).not.toMatch(/\.detail\s*\{[^}]*grid-column/);
    expect(css).not.toMatch(/\.detail\s*\{[^}]*left:\s*300px/);
    expect(css).toMatch(/\.detail\s*\{[^}]*position:\s*fixed[^}]*align-items:\s*center[^}]*justify-content:\s*center/);
    expect(css).toMatch(/\.detail-box\s*\{/);
    expect(html).toContain('class="detail-box"');
    // Título longo (worker id) não pode empurrar a caixa: flex com piso zero.
    expect(css).toMatch(/\.detail-title\s*\{[^}]*flex:\s*1[^}]*min-width:\s*0/);
  });

  it('bloco de código rola em vez de cortar linha longa', () => {
    const css = readFileSync(resolve(process.cwd(), 'ui/src/styles.css'), 'utf8');
    expect(css).toMatch(/\.md-code-box pre\s*\{[^}]*overflow-x:\s*auto/);
  });
});

describe('avisos de extensão no Debug e overlay Sobre', () => {
  it('renderHealthList escreve o vazio no #healthlist (id tem que bater com o index.html)', () => {
    // Sem sessão atual o mapa não existe: o overlay precisa dizer isso, não ficar em branco.
    renderHealthList();
    const host = document.getElementById('healthlist');
    expect(host).not.toBeNull();
    expect(host.textContent).toContain('nenhum aviso');
  });

  it('renderHealthList lista kind + mensagem de cada aviso (o que o chip só conta)', () => {
    renderHealthList(new Map([
      ['MCP servers need attention: fetch failed', 'mcp'],
      ['LSP inactive', 'lsp'],
    ]));
    const rows = document.querySelectorAll('#healthlist .file-row');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('MCP servers need attention');
    expect(rows[0].textContent).toContain('mcp');
    expect(rows[1].textContent).toContain('lsp');
  });

  it('todo id que o main.js consulta no Sobre/avisos existe no index.html', () => {
    for (const id of ['about', 'aboutback', 'aboutlist', 'aboutbtn', 'healthlist', 'healthchip']) {
      expect(document.getElementById(id), id).not.toBeNull();
    }
  });
});

describe('duplicação de resposta ao voltar para a aba', () => {
  it('não reanexa o parcial quando o disco já pintou a resposta inteira', () => {
    // Regressão: trocar de aba no meio do stream e voltar duplicava a mesma resposta.
    const rendered = ['Rode isso para validar.', 'Rode isso para validar.\n\nSegunda parte'];
    expect(answerAlreadyRendered('Rode isso para validar.', rendered)).toBe(true);
    expect(answerAlreadyRendered('Rode isso para validar.', ['outra resposta'])).toBe(false);
    // Parcial mais longo que o texto já pintado não é duplicata: ainda há stream.
    expect(answerAlreadyRendered('Rode isso para validar.\n\nAinda escrevendo', rendered)).toBe(false);
  });

  it('normaliza espaços antes de comparar (parcial x markdown do disco)', () => {
    expect(answerAlreadyRendered('linha 1\n\nlinha 2', ['linha 1\n\n  linha 2  '])).toBe(true);
    expect(normalizeRowText('  a\n  b  ')).toBe('a b');
  });

  it('parcial vazio nunca conta como resposta já pintada', () => {
    expect(answerAlreadyRendered('', ['qualquer'])).toBe(false);
    expect(answerAlreadyRendered('   ', ['qualquer'])).toBe(false);
  });
});

describe('mensagem do usuário não some ao trocar de conversa', () => {
  it('deduplica texto cru local contra o texto trim() do disco', () => {
    const seen = new Set([normalizeRowText('prompt grande\n')]);
    expect(shouldRestoreLocalRow({ text: 'prompt grande\n', state: 'pending' }, seen)).toBe(false);
  });

  it('reinsere quando o disco não tem a mensagem (linha grande omitida)', () => {
    const seen = new Set([normalizeRowText('outra mensagem')]);
    expect(shouldRestoreLocalRow({ text: 'prompt com imagem', state: 'pending' }, seen)).toBe(true);
  });
});

describe('tempo dos runs ao vivo', () => {
  it('run em andamento usa `now`, então o relógio anda a cada repaint', () => {
    const run = { state: 'running', startedAt: 1_000_000 };
    expect(elapsedFor(run, 1_011_000)).toBe('11s');
    expect(elapsedFor(run, 1_131_000)).toBe('2m11');
    expect(elapsedFor(run, 1_005_000)).toBe('5s');
  });

  it('run terminado congela no updatedAt/endedAt', () => {
    const run = { state: 'complete', startedAt: 1_000_000, updatedAt: 1_125_000 };
    expect(elapsedFor(run, 9_999_999)).toBe('2m05');
  });

  it('classifica só running/queued como ao vivo', () => {
    expect(isLiveRun({ state: 'running' })).toBe(true);
    expect(isLiveRun({ state: 'queued' })).toBe(true);
    expect(isLiveRun({ state: 'complete' })).toBe(false);
    expect(isLiveRun(null)).toBe(false);
  });
});

describe('painel de subagents: relógio ao vivo', () => {
  it('o tempo do run em andamento avança sozinho, sem novo snapshot', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:11Z'));
    try {
      renderSubs({
        runs: [{
          id: 'run-1', label: 'worker, worker, worker, +1 more', kind: 'subagent',
          state: 'running', startedAt: Date.now() - 11000,
          children: [{ id: 'c1', label: 'manifest', state: 'complete', startedAt: Date.now() - 9000, updatedAt: Date.now() - 1000 }],
        }],
      });
      expect(document.getElementById('subs').textContent).toContain('11s');
      vi.advanceTimersByTime(3000);
      expect(document.getElementById('subs').textContent).toContain('14s');
      // O child terminado congela no próprio updatedAt (não acompanha o relógio).
      expect(document.getElementById('subs').textContent).toContain('8s');
    } finally {
      renderSubs(null);
      vi.advanceTimersByTime(1000);
      vi.useRealTimers();
    }
  });
});

describe('reattachPlan (âncora antes do descarte)', () => {
  it('turno encerrado descarta o parcial: o disco manda', () => {
    expect(reattachPlan({ working: false, streamText: 'x', renderedBody: true, tailInLog: true })).toBe('drop-turn');
  });

  it('sem parcial, só ancora no bloco de thinking', () => {
    expect(reattachPlan({ working: true, streamText: '', renderedBody: null, tailInLog: false })).toBe('thinking');
  });

  it('bloco já pintado vence o descarte por cauda (não cria 2ª cópia)', () => {
    expect(reattachPlan({ working: true, streamText: 'Rode isso', renderedBody: true, tailInLog: true })).toBe('anchor');
  });

  it('parcial truncado que é sufixo do log é descartado', () => {
    expect(reattachPlan({ working: true, streamText: 'final da resposta', renderedBody: false, tailInLog: true })).toBe('drop-tail');
  });

  it('nada pintado: abre o bloco com o parcial', () => {
    expect(reattachPlan({ working: true, streamText: 'começando', renderedBody: false, tailInLog: false })).toBe('append');
  });
});

describe('renderedAnswerNode (âncora do parcial em vez de 2ª cópia)', () => {
  it('acha o bloco já pintado e não deixa o próximo delta abrir outra resposta', () => {
    const log = document.getElementById('log');
    log.innerHTML = '';
    const firstUser = document.createElement('div');
    firstUser.className = 'row user';
    const old = document.createElement('div');
    old.className = 'md-body';
    old._md = 'resposta anterior';
    const curUser = document.createElement('div');
    curUser.className = 'row user';
    const cur = document.createElement('div');
    cur.className = 'md-body';
    cur._md = 'Rode isso para validar.\n\nDetalhes finais.';
    log.append(firstUser, old, curUser, cur);

    expect(renderedAnswerNode('Rode isso para validar.')).toBe(cur);
    expect(renderedAnswerNode('texto que não está no log')).toBe(null);
    // Resposta de um turno ANTERIOR não pode ser a âncora do stream atual.
    expect(renderedAnswerNode('resposta anterior')).toBe(null);
    log.innerHTML = '';
  });
});

describe('tokens do turno em voo (mensagem ainda não persistida)', () => {
  const usage = (over = {}) => ({
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, ...over,
  });

  it('estima tokens por conteúdo como o pi (4 chars/token)', () => {
    expect(estimateMessageTokens({ content: [{ type: 'text', text: 'a'.repeat(400) }] })).toBe(100);
    expect(estimateMessageTokens({ content: [{ type: 'thinking', thinking: 'b'.repeat(800) }] })).toBe(200);
    const tool = { type: 'toolCall', name: 'read', arguments: { path: 'x'.repeat(343) } };
    const toolChars = tool.name.length + JSON.stringify(tool.arguments).length;
    expect(estimateMessageTokens({ content: [tool] })).toBe(Math.ceil(toolChars / 4));
    expect(estimateMessageTokens(null)).toBe(0);
  });

  it('usa usage do parcial quando o provider já informou; senão estima', () => {
    const msg = { content: [{ type: 'text', text: 'a'.repeat(400) }], usage: usage() };
    expect(liveTurnTokens(msg)).toBe(100);
    msg.usage = usage({ input: 1000, output: 200, totalTokens: 1200 });
    expect(liveTurnTokens(msg)).toBe(1200);
  });

  it('soma o parcial aos totals e ao contexto e recalcula o %', () => {
    const data = {
      tokens: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, total: 1500 },
      contextUsage: { tokens: 120_000, contextWindow: 1_000_000, percent: 12 },
      totalMessages: 10,
    };
    const snapshot = JSON.parse(JSON.stringify(data));
    const view = liveStatsView(data, { billed: 800, context: 600 });
    expect(view.billed).toBe(800);
    expect(view.ctxDelta).toBe(600);
    expect(view.stats.tokens.total).toBe(2300);
    expect(view.stats.contextUsage.tokens).toBe(120_600);
    expect(view.stats.contextUsage.percent).toBeCloseTo(12.06, 5);
    expect(data).toEqual(snapshot); // não muta o cache do RPC
  });

  it('sem parcial devolve os stats intactos', () => {
    const data = { tokens: { total: 10 }, contextUsage: { tokens: 5, contextWindow: 100, percent: 5 } };
    const view = liveStatsView(data, null);
    expect(view.billed).toBe(0);
    expect(view.ctxDelta).toBe(0);
    expect(view.stats).toBe(data);
  });

  it('não estoura a janela de contexto', () => {
    const view = liveStatsView(
      { tokens: { total: 0 }, contextUsage: { tokens: 99_900, contextWindow: 100_000, percent: 99.9 } },
      { billed: 10, context: 5000 },
    );
    expect(view.stats.contextUsage.tokens).toBe(100_000);
    expect(view.stats.contextUsage.percent).toBe(100);
  });
});
