/* Presets de tema: mapas parciais de tokens (chaves ⊆ THEME_KEYS).
 * Parcial é suficiente: `applyTheme` limpa os 46 tokens e aplica só os que vieram
 * no mapa — o que faltar cai no default do `styles.css` (dark). Nomes próprios
 * (One Dark, Darcula…) não passam por i18n; só os rótulos do diálogo passam.
 * Valores aproximados das paletas originais, ajustados ao conjunto de 16 tokens
 * que o sightdeck usa no chrome (fundo/painel/texto/estados). */
export const PRESETS = [
  { id: 'sightdeck', name: 'Sightdeck Dark', tokens: {} },
  {
    id: 'one-dark', name: 'One Dark', tokens: {
      bg: '#282c34', panel: '#21252b', card: '#21252b', line: '#2c313c',
      'line-soft': '#232830', fg: '#abb2bf', dim: '#828997', mute: '#5c6370',
      'code-bg': '#1e222a', accent: '#61afef', ok: '#98c379', warn: '#e5c07b',
      err: '#e06c75', sel: '#2c313c', hover: '#2c313c', 'ctl-bg': '#2c313c',
    },
  },
  {
    id: 'darcula', name: 'Darcula', tokens: {
      bg: '#2b2b2b', panel: '#3c3f41', card: '#3c3f41', line: '#4c5052',
      'line-soft': '#3c3f41', fg: '#a9b7c6', dim: '#8a929c', mute: '#606366',
      'code-bg': '#2b2b2b', accent: '#cc7832', ok: '#6a8759', warn: '#e8bf6a',
      err: '#e06c75', sel: '#214283', hover: '#35383b', 'ctl-bg': '#3c3f41',
    },
  },
  {
    id: 'dracula', name: 'Dracula', tokens: {
      bg: '#282a36', panel: '#343746', card: '#343746', line: '#44475a',
      'line-soft': '#343746', fg: '#f8f8f2', dim: '#b6b9c9', mute: '#6272a4',
      'code-bg': '#21222c', accent: '#bd93f9', ok: '#50fa7b', warn: '#f1fa8c',
      err: '#ff5555', sel: '#44475a', hover: '#343746', 'ctl-bg': '#343746',
    },
  },
  {
    id: 'gruvbox', name: 'Gruvbox Dark', tokens: {
      bg: '#282828', panel: '#3c3836', card: '#3c3836', line: '#504945',
      'line-soft': '#3c3836', fg: '#ebdbb2', dim: '#bdae93', mute: '#928374',
      'code-bg': '#1d2021', accent: '#fe8019', ok: '#b8bb26', warn: '#fabd2f',
      err: '#fb4934', sel: '#504945', hover: '#3c3836', 'ctl-bg': '#3c3836',
    },
  },
  {
    id: 'nord', name: 'Nord', tokens: {
      bg: '#2e3440', panel: '#3b4252', card: '#3b4252', line: '#4c566a',
      'line-soft': '#3b4252', fg: '#d8dee9', dim: '#8e97ad', mute: '#616e88',
      'code-bg': '#242933', accent: '#88c0d0', ok: '#a3be8c', warn: '#ebcb8b',
      err: '#bf616a', sel: '#434c5e', hover: '#3b4252', 'ctl-bg': '#3b4252',
    },
  },
];

/** Acha o preset pelo id (ou null). */
export function presetById(id) {
  return PRESETS.find((p) => p && p.id === id) || null;
}
