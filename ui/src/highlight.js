import Prism from './prism-setup.js';
import 'prismjs/components/prism-clike';
import 'prismjs/components/prism-markup';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-markdown';

/* =============== highlight de código (Prism tokenizado, DOM puro) =============== */

/** Extensão de arquivo/alias de cerca → grammar carregada. O resto cai em `plain`. */
const LANG_BY_NAME = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', javascript: 'javascript',
  ts: 'typescript', tsx: 'typescript', typescript: 'typescript',
  rs: 'rust', rust: 'rust',
  py: 'python', python: 'python',
  json: 'json',
  sh: 'bash', bash: 'bash', zsh: 'bash', shell: 'bash',
  css: 'css',
  html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', markup: 'markup',
  md: 'markdown', markdown: 'markdown',
};

/** Linha acima disto não compensa tokenizar (nem no diff, nem num bloco colado). */
const LONG_LINE = 2000;

/** Caminho de arquivo (`src/a.ts`) ou cerca (`ts`, `ts arquivo.ts`) → grammar. */
export function langFor(fileOrLang) {
  const raw = String(fileOrLang == null ? '' : fileOrLang).trim().toLowerCase();
  if (!raw) return 'plain';
  const base = raw.replace(/\\/g, '/').split('/').pop();
  const name = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : base;
  const lang = LANG_BY_NAME[name] || name;
  return Prism.languages[lang] ? lang : 'plain';
}

/** Percorre a árvore de tokens do Prism achatando em folhas, herdando as classes
    dos tokens pais (`token string token interpolation`). */
function collect(tokens, out, parentCls) {
  for (const token of tokens) {
    if (typeof token === 'string') {
      if (token) out.push({ t: 'text', v: token });
      continue;
    }
    const own = `token ${[token.type].concat(token.alias ? [].concat(token.alias) : []).join(' token ')}`;
    const cls = parentCls ? `${parentCls} ${own}` : own;
    const content = token.content;
    if (typeof content === 'string') {
      if (content) out.push({ t: 'tok', cls, v: content });
    } else {
      collect(Array.isArray(content) ? content : [content], out, cls);
    }
  }
}

/** Alguma linha passou do limite de tokenização. */
function tooLong(text) {
  return text.length > LONG_LINE && text.split('\n').some((line) => line.length > LONG_LINE);
}

/**
 * Highlight serializável (testável sem DOM): folhas `{t:'text',v}` e
 * `{t:'tok',cls,v}`. Concatenar os `v` devolve o texto original; grammar
 * desconhecida ou erro de tokenize devolve o texto cru, sem lançar.
 */
export function tokenSpecs(code, lang) {
  const text = String(code == null ? '' : code);
  const grammar = Prism.languages[langFor(lang)];
  if (!grammar || tooLong(text)) return [{ t: 'text', v: text }];
  try {
    const out = [];
    collect(Prism.tokenize(text, grammar), out, '');
    return out;
  } catch {
    return [{ t: 'text', v: text }];
  }
}

/** Anexa o código destacado ao nó: só `createElement`/`createTextNode`. */
export function appendHighlighted(node, code, lang) {
  for (const spec of tokenSpecs(code, lang)) {
    if (spec.t === 'tok') {
      const span = document.createElement('span');
      span.className = spec.cls;
      span.appendChild(document.createTextNode(spec.v));
      node.appendChild(span);
    } else {
      node.appendChild(document.createTextNode(spec.v));
    }
  }
  return node;
}
