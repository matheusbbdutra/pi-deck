/* =============== tema por JSON: validação leniente + persistência =============== */

/**
 * Os 46 tokens semânticos de `styles.css` (o `:root`), sem o prefixo `--` e sem
 * `--mono` (fonte não é tema). É a allowlist: chave fora daqui nunca é aplicada.
 */
export const THEME_KEYS = [
  // base
  'bg', 'panel', 'card', 'line', 'line-soft', 'fg', 'dim', 'mute', 'code-bg',
  'accent', 'ok', 'warn', 'err',
  // fundos do poço ao card
  'bg-0', 'bg-1', 'bg-2', 'bg-3', 'bg-4',
  // texto do mais forte ao mais fraco
  'ink-0', 'ink-1', 'ink-2', 'ink-3', 'ink-4', 'ink-5', 'ink-6',
  // bordas que não são --line/--line-soft
  'line-strong', 'line-card', 'line-think',
  // controle, seleção, hovers, chips
  'ctl-bg', 'sel', 'hover', 'hover-soft', 'hover-chip', 'chip', 'badge',
  // estados
  'ok-bg', 'ok-bg-2', 'ok-ink', 'ok-line', 'ok-line-2',
  'warn-bg', 'warn-bg-2', 'warn-line',
  'err-bg', 'err-bg-2',
  'dot-off',
];

const KNOWN = new Set(THEME_KEYS);
const STORAGE_KEY = 'theme';

/* Cor aceita: hex de 3/6/8 dígitos ou rgb()/rgba()/hsl()/hsla() com corpo numérico.
   Qualquer outra coisa (`url(...)`, `expression`, número, vazio) é ignorada. */
const COLOR_RE = /^(?:#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgba?|hsla?)\([0-9a-z.%,\s/+-]*\))$/i;

/** `bg`, `--bg` e ` BG ` valem o mesmo token: a chave canônica é sem prefixo. */
function canonicalKey(key) {
  return String(key).trim().replace(/^-+/, '');
}

/**
 * Filtra um tema: devolve `{ ok: {chave: valor}, ignored: [chave original], error? }`.
 * Aceita objeto já parseado ou string JSON (parse tolerante). Nunca lança: entrada
 * inválida vira `error` (a UI mostra na linha de status).
 */
export function validateTheme(input) {
  let raw = input;
  if (typeof input === 'string') {
    const text = input.trim();
    if (!text) return { ok: {}, ignored: [], error: 'JSON vazio' };
    try {
      raw = JSON.parse(text);
    } catch (e) {
      return { ok: {}, ignored: [], error: 'JSON inválido: ' + (e && e.message ? e.message : String(e)) };
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: {}, ignored: [], error: 'esperado um objeto JSON { "token": "cor" }' };
  }
  const ok = {};
  const ignored = [];
  for (const key of Object.keys(raw)) {
    const value = raw[key];
    const name = canonicalKey(key);
    if (!KNOWN.has(name) || typeof value !== 'string' || !COLOR_RE.test(value.trim())) {
      ignored.push(key);
      continue;
    }
    ok[name] = value.trim();
  }
  return { ok, ignored };
}

function applyValidated(ok) {
  const root = document.documentElement;
  for (const key of Object.keys(ok)) root.style.setProperty('--' + key, ok[key]);
}

function persist(ok) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(ok)); } catch { /* sem storage: vale até recarregar */ }
}

/** Aplica só as chaves conhecidas com valor de cor válido e persiste em `localStorage['theme']`.
    O mapa aplicado é o mapa salvo: os 46 tokens são limpos antes, então o que não veio
    no JSON volta ao valor do `styles.css`. Entrada com erro de parse não mexe em nada. */
export function applyTheme(input) {
  const res = validateTheme(input);
  if (res.error) return res;
  const root = document.documentElement;
  for (const key of THEME_KEYS) root.style.removeProperty('--' + key);
  applyValidated(res.ok);
  persist(res.ok);
  return res;
}

/** Volta aos valores do `styles.css`: remove os 46 tokens do elemento raiz e a chave salva. */
export function resetTheme() {
  const root = document.documentElement;
  for (const key of THEME_KEYS) root.style.removeProperty('--' + key);
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* sem storage */ }
}

/** Valores atuais dos 46 tokens (para exportar). Token sem valor computado fica fora. */
export function themeFromDom() {
  const root = document.documentElement;
  const computed = typeof getComputedStyle === 'function' ? getComputedStyle(root) : null;
  const out = {};
  for (const key of THEME_KEYS) {
    let value = computed ? computed.getPropertyValue('--' + key) : '';
    if (!value) value = root.style.getPropertyValue('--' + key);
    value = String(value || '').trim();
    if (value) out[key] = value;
  }
  return out;
}

/** Boot: aplica o tema salvo (só o que continuar válido). Sem chave salva não faz nada. */
export function bootTheme() {
  let stored = null;
  try { stored = localStorage.getItem(STORAGE_KEY); } catch { return; }
  if (!stored) return;
  const res = validateTheme(stored);
  applyValidated(res.ok);
}
