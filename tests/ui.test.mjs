import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

const HTML = fs.readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');

/** Sobe a UI real no jsdom, com o IPC do Tauri stubado (nunca resolve). */
function boot(t) {
  const listeners = {};
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(e));
  const dom = new JSDOM(HTML, {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(w) {
      w.__TAURI__ = {
        core: { invoke: () => new Promise(() => {}) },
        event: { listen: (name, cb) => { listeners[name] = cb; return Promise.resolve(() => {}); } },
      };
    },
  });
  t.after(() => dom.window.close());
  return { dom, win: dom.window, doc: dom.window.document, listeners, errors };
}

function key(win, opts) {
  win.document.dispatchEvent(new win.KeyboardEvent('keydown', {
    bubbles: true, cancelable: true, ...opts,
  }));
}

test('zoom: botões, atalhos, reset e limites', (t) => {
  const { win, doc, errors } = boot(t);
  assert.equal(errors.length, 0, 'a UI não pode lançar erro ao carregar');
  assert.equal(Number(doc.body.style.zoom), 1);

  doc.getElementById('zoomin').click();
  assert.equal(Number(doc.body.style.zoom), 1.1);
  assert.equal(win.localStorage.getItem('zoom'), '1.1');

  doc.getElementById('zoomout').click();
  assert.equal(Number(doc.body.style.zoom), 1);

  key(win, { key: '=', ctrlKey: true });
  assert.equal(Number(doc.body.style.zoom), 1.1);
  key(win, { key: '-', ctrlKey: true });
  assert.equal(Number(doc.body.style.zoom), 1);
  key(win, { key: '=', ctrlKey: true });
  key(win, { key: '0', ctrlKey: true });
  assert.equal(Number(doc.body.style.zoom), 1);

  win.setZoom(99);
  assert.equal(Number(doc.body.style.zoom), 2);
  win.setZoom(0.01);
  assert.equal(Number(doc.body.style.zoom), 0.6);
});

test('zoom: layout reflui (CSS zoom) e composer quebra linha', () => {
  assert.match(HTML, /document\.body\.style\.zoom/);
  assert.doesNotMatch(HTML, /set_webview_zoom/);
  assert.match(HTML, /grid-template-columns:min\(300px,24%\) 1fr min\(340px,27%\)/);
  assert.match(HTML, /\.composer-bar \{ display:flex; flex-wrap:wrap/);
});

test('detalhe do subagent acompanha a coluna central (dentro do main)', (t) => {
  const { doc, errors } = boot(t);
  assert.equal(errors.length, 0);
  assert.equal(doc.getElementById('detail').parentElement.tagName, 'MAIN');
  assert.match(HTML, /\.detail \{ position:absolute; inset:0;/);
});

test('Esc: interrompe só turno ativo e sem modal aberto', (t) => {
  const { win, doc, errors } = boot(t);
  assert.equal(errors.length, 0);
  win.eval('current = { key: "a" }; tabs = [{ key: "a", working: true }]');
  let calls = 0;
  win.abortTurn = () => { calls++; };

  key(win, { key: 'Escape' });
  assert.equal(calls, 1, 'Esc deve abortar o turno em andamento');

  win.eval('tabs[0].working = false');
  key(win, { key: 'Escape' });
  assert.equal(calls, 1, 'sem turno rodando, Esc não dispara abort');

  win.eval('tabs[0].working = true');
  doc.getElementById('modelpop').classList.remove('hidden');
  key(win, { key: 'Escape' });
  assert.equal(calls, 1, 'modal aberto: Esc fecha o modal, não aborta');

  doc.getElementById('modelpop').classList.add('hidden');
  doc.getElementById('pkgs').classList.remove('hidden');
  key(win, { key: 'Escape' });
  assert.equal(calls, 1, 'overlay aberto: Esc não aborta');
});

test('troca de aba: stash/restore preserva thinking e tool, sem duplicar o disco', (t) => {
  const { win, doc, errors } = boot(t);
  assert.equal(errors.length, 0);
  win.eval(`
    current = { key: "a" };
    tabs = [{ key: "a" }];
    document.getElementById("log").innerHTML =
      '<div class="think-block" data-live="1"><div class="think-body">pensou A</div></div>' +
      '<div class="tool-card" data-live="1" data-call-id="c1"><div class="tool-body">saída A</div></div>';
  `);

  win.stashLive();
  assert.equal(win.eval('tabs[0].liveNodes.length'), 2);
  assert.equal(win.eval('tabs[0].bgThink.textContent'), 'pensou A');

  win.eval('document.getElementById("log").innerHTML = ""; restoreLive()');
  assert.equal(doc.querySelectorAll('#log .think-block').length, 1);
  assert.equal(doc.querySelectorAll('#log .tool-card').length, 1);

  // O disco já tem o tool c1: reanexar o stash duplicaria o card.
  win.eval('document.getElementById("log").innerHTML = \'<div class="tool-card" data-call-id="c1"></div>\'; restoreLive()');
  assert.equal(doc.querySelectorAll('#log .tool-card').length, 1);
});

test('aba em segundo plano acumula thinking e texto parcial', (t) => {
  const { win, listeners, errors } = boot(t);
  assert.equal(errors.length, 0);
  win.eval('current = { key: "front" }; tabs = [{ key: "front" }, { key: "bg" }]');

  const onLine = listeners['rpc-line'];
  assert.equal(typeof onLine, 'function');
  onLine({ payload: ['bg', JSON.stringify({
    type: 'message_update',
    assistantMessageEvent: { type: 'thinking_delta', delta: 'pensa' },
  })] });
  assert.equal(win.eval('tabs[1].liveNodes[0].querySelector(".think-body").textContent'), 'pensa');

  onLine({ payload: ['bg', JSON.stringify({
    type: 'message_update',
    assistantMessageEvent: { type: 'thinking_delta', delta: ' mais' },
  })] });
  assert.equal(win.eval('tabs[1].liveNodes[0].querySelector(".think-body").textContent'), 'pensa mais');

  onLine({ payload: ['bg', JSON.stringify({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'resposta' },
  })] });
  assert.equal(win.eval('tabs[1].streamText'), 'resposta');
});

test('thinking expandido rola para o último token', (t) => {
  const { win, listeners, errors } = boot(t);
  assert.equal(errors.length, 0);
  Object.defineProperty(win.HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get() { return 123; },
  });
  win.eval('current = { key: "a" }; tabs = [{ key: "a", working: true }]');

  listeners['rpc-line']({ payload: ['a', JSON.stringify({
    type: 'message_update',
    assistantMessageEvent: { type: 'thinking_delta', delta: 'token final' },
  })] });

  const body = win.eval('stream.thinkBody');
  assert.equal(body.textContent, 'token final');
  assert.equal(body.scrollTop, 123, 'o .think-body precisa acompanhar o fim');
});
