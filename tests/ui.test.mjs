// @vitest-environment jsdom
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = process.cwd();
const HTML = fs.readFileSync(path.join(ROOT, 'ui/index.html'), 'utf8');
const BODY = new JSDOM(HTML).window.document.body.innerHTML
  .replace(/<script[\s\S]*?<\/script>/gi, '');

let mod;
let listeners;
let calls;

beforeAll(async () => {
  vi.useFakeTimers();
  document.body.innerHTML = BODY;
  listeners = {};
  calls = [];
  window.__TAURI__ = {
    core: {
      invoke: (cmd, args) => {
        calls.push({ cmd, args });
        return new Promise(() => {});
      },
    },
    event: {
      listen: (name, cb) => {
        listeners[name] = cb;
        return Promise.resolve(() => {});
      },
    },
  };
  mod = await import('../ui/src/main.js');
});

afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  calls.length = 0;
  localStorage.clear();
  mod.__test.reset();
  mod.__test.setZoom(1);
  document.getElementById('log').innerHTML = '';
  for (const sel of ['.overlay', '.model-pop', '.palette', '.img-view', '.settings-pop', '.confirm-bar']) {
    document.querySelectorAll(sel).forEach(n => n.classList.add('hidden'));
  }
});

function key(opts) {
  document.dispatchEvent(new window.KeyboardEvent('keydown', {
    bubbles: true, cancelable: true, ...opts,
  }));
}

function rpcCalls() {
  return calls.filter(c => c.cmd === 'rpc_command');
}

describe('zoom', () => {
  it('botões, atalhos, reset e limites', () => {
    expect(Number(document.body.style.zoom)).toBe(1);

    document.getElementById('zoomin').click();
    expect(Number(document.body.style.zoom)).toBe(1.1);
    expect(localStorage.getItem('zoom')).toBe('1.1');

    document.getElementById('zoomout').click();
    expect(Number(document.body.style.zoom)).toBe(1);

    key({ key: '=', ctrlKey: true });
    expect(Number(document.body.style.zoom)).toBe(1.1);
    key({ key: '-', ctrlKey: true });
    expect(Number(document.body.style.zoom)).toBe(1);
    key({ key: '=', ctrlKey: true });
    key({ key: '0', ctrlKey: true });
    expect(Number(document.body.style.zoom)).toBe(1);

    mod.__test.setZoom(99);
    expect(Number(document.body.style.zoom)).toBe(2);
    mod.__test.setZoom(0.01);
    expect(Number(document.body.style.zoom)).toBe(0.6);
  });

  it('reflui com CSS zoom e composer quebra linha', () => {
    const js = fs.readFileSync(path.join(ROOT, 'ui/src/main.js'), 'utf8');
    const css = fs.readFileSync(path.join(ROOT, 'ui/src/styles.css'), 'utf8');
    expect(js).toContain('document.body.style.zoom');
    expect(js).not.toContain('set_webview_zoom');
    expect(css).toContain('grid-template-columns:min(300px,24%) 1fr min(340px,27%)');
    expect(css).toContain('.composer-bar { display:flex; flex-wrap:wrap');
  });

  it('o detalhe do subagent fica dentro do main', () => {
    expect(document.getElementById('detail').parentElement.tagName).toBe('MAIN');
    const css = fs.readFileSync(path.join(ROOT, 'ui/src/styles.css'), 'utf8');
    expect(css).toContain('.detail { position:absolute; inset:0;');
  });
});

describe('Esc interrompe o turno', () => {
  it('só aborta com turno ativo e sem modal aberto', () => {
    mod.__test.setState('a', true);
    rpcCalls().length = 0;

    key({ key: 'Escape' });
    const types = rpcCalls().map(c => JSON.parse(c.args.payload).type);
    expect(types).toEqual(['clear_queue', 'abort']);

    calls.length = 0;
    mod.__test.setState('a', false);
    key({ key: 'Escape' });
    expect(rpcCalls()).toHaveLength(0);

    calls.length = 0;
    mod.__test.setState('a', true);
    document.getElementById('modelpop').classList.remove('hidden');
    key({ key: 'Escape' });
    expect(rpcCalls()).toHaveLength(0);

    document.getElementById('modelpop').classList.add('hidden');
    document.getElementById('pkgs').classList.remove('hidden');
    key({ key: 'Escape' });
    expect(rpcCalls()).toHaveLength(0);
  });
});

describe('troca de aba', () => {
  it('stash/restore preserva thinking e tool, sem duplicar o disco', () => {
    mod.__test.setState('a', false);
    document.getElementById('log').innerHTML =
      '<div class="think-block" data-live="1"><div class="think-body">pensou A</div></div>' +
      '<div class="tool-card" data-live="1" data-call-id="c1"><div class="tool-body">saída A</div></div>';

    mod.__test.stashLive();
    expect(mod.__test.tabs[0].liveNodes).toHaveLength(2);
    expect(mod.__test.tabs[0].bgThink.textContent).toBe('pensou A');

    document.getElementById('log').innerHTML = '';
    mod.__test.restoreLive();
    expect(document.querySelectorAll('#log .think-block')).toHaveLength(1);
    expect(document.querySelectorAll('#log .tool-card')).toHaveLength(1);

    // O disco já tem o tool c1: reanexar o stash duplicaria o card.
    document.getElementById('log').innerHTML = '<div class="tool-card" data-call-id="c1"></div>';
    mod.__test.restoreLive();
    expect(document.querySelectorAll('#log .tool-card')).toHaveLength(1);
  });

  it('aba em segundo plano acumula thinking e texto parcial', () => {
    mod.__test.setTabs(['front', 'bg'], 'front');
    const onLine = listeners['rpc-line'];
    expect(typeof onLine).toBe('function');

    onLine({ payload: ['bg', JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', delta: 'pensa' },
    })] });
    expect(mod.__test.tabs[1].liveNodes[0].querySelector('.think-body').textContent).toBe('pensa');

    onLine({ payload: ['bg', JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', delta: ' mais' },
    })] });
    expect(mod.__test.tabs[1].liveNodes[0].querySelector('.think-body').textContent).toBe('pensa mais');

    onLine({ payload: ['bg', JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'resposta' },
    })] });
    expect(mod.__test.tabs[1].streamText).toBe('resposta');
  });
});

describe('thinking expandido', () => {
  it('rola para o último token', () => {
    const proto = window.HTMLElement.prototype;
    const orig = Object.getOwnPropertyDescriptor(proto, 'scrollHeight');
    Object.defineProperty(proto, 'scrollHeight', { configurable: true, get() { return 123; } });
    try {
      mod.__test.setState('a', true);
      listeners['rpc-line']({ payload: ['a', JSON.stringify({
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', delta: 'token final' },
      })] });
      const body = mod.__test.stream.thinkBody;
      expect(body.textContent).toBe('token final');
      expect(body.scrollTop).toBe(123);
    } finally {
      if (orig) Object.defineProperty(proto, 'scrollHeight', orig);
      else delete proto.scrollHeight;
    }
  });
});
