/* Presets de tema: mapas parciais de tokens (chaves ⊆ THEME_KEYS).
 * Parcial é suficiente: `applyTheme` limpa os 46 tokens e aplica só os que vieram
 * no mapa — o que faltar cai no default do `styles.css` (dark). Nomes próprios
 * (One Dark, Darcula…) não passam por i18n; só os rótulos do diálogo passam.
 * Cada preset cobre fundos (bg-0..4), inks (0..6), bordas, controles, hovers,
 * chips e estados — sem isso o tema parece "fraco" (só bg/panel/accent mudavam). */
export const PRESETS = [
  { id: 'sightdeck', name: 'Sightdeck Dark', tokens: {} },
  {
    id: 'one-dark', name: 'One Dark', tokens: {
      bg: '#282c34', panel: '#21252b', card: '#21252b',
      line: '#3a3f4b', 'line-soft': '#2c313a', 'line-strong': '#4b5263',
      'line-card': '#343a46', 'line-think': '#3e4451',
      fg: '#abb2bf', dim: '#828997', mute: '#5c6370', 'code-bg': '#1e222a',
      'bg-0': '#1e222a', 'bg-1': '#21252b', 'bg-2': '#242830', 'bg-3': '#262a33', 'bg-4': '#282c34',
      'ink-0': '#ffffff', 'ink-1': '#c8ccd4', 'ink-2': '#b6bcc8', 'ink-3': '#abb2bf',
      'ink-4': '#9aa1af', 'ink-5': '#828997', 'ink-6': '#5c6370',
      'ctl-bg': '#2c313c', sel: '#2c313c', hover: '#2c313c', 'hover-soft': '#242830', 'hover-chip': '#2a2f3a',
      chip: '#323844', badge: '#3a4150',
      accent: '#61afef', ok: '#98c379', warn: '#e5c07b', err: '#e06c75',
      'ok-bg': '#1e3a26', 'ok-bg-2': '#22301f', 'ok-ink': '#98c379', 'ok-line': '#2f5a3a', 'ok-line-2': '#3a6b45',
      'warn-bg': '#3a3320', 'warn-bg-2': '#2e2818', 'warn-line': '#4a3f22',
      'err-bg': '#3a2226', 'err-bg-2': '#45262c',
      'dot-off': '#4b5263',
    },
  },
  {
    id: 'darcula', name: 'Darcula', tokens: {
      bg: '#2b2b2b', panel: '#3c3f41', card: '#3c3f41',
      line: '#4c5052', 'line-soft': '#3c3f41', 'line-strong': '#5a5f61',
      'line-card': '#454a4c', 'line-think': '#4c5052',
      fg: '#a9b7c6', dim: '#8a929c', mute: '#606366', 'code-bg': '#232323',
      'bg-0': '#232323', 'bg-1': '#282828', 'bg-2': '#2b2b2b', 'bg-3': '#303030', 'bg-4': '#3c3f41',
      'ink-0': '#e8eef5', 'ink-1': '#c6d0db', 'ink-2': '#b8c2cf', 'ink-3': '#a9b7c6',
      'ink-4': '#96a4b3', 'ink-5': '#8a929c', 'ink-6': '#606366',
      'ctl-bg': '#3c3f41', sel: '#214283', hover: '#35383b', 'hover-soft': '#313335', 'hover-chip': '#3a3d3f',
      chip: '#3c3f41', badge: '#454a4c',
      accent: '#cc7832', ok: '#6a8759', warn: '#e8bf6a', err: '#e06c75',
      'ok-bg': '#2f3d28', 'ok-bg-2': '#293324', 'ok-ink': '#8fb57c', 'ok-line': '#3f5636', 'ok-line-2': '#4a6540',
      'warn-bg': '#3d3520', 'warn-bg-2': '#332c1a', 'warn-line': '#4d4227',
      'err-bg': '#3d2429', 'err-bg-2': '#48292f',
      'dot-off': '#5a5f61',
    },
  },
  {
    id: 'dracula', name: 'Dracula', tokens: {
      bg: '#282a36', panel: '#343746', card: '#343746',
      line: '#44475a', 'line-soft': '#343746', 'line-strong': '#52566b',
      'line-card': '#3d4152', 'line-think': '#44475a',
      fg: '#f8f8f2', dim: '#b6b9c9', mute: '#6272a4', 'code-bg': '#21222c',
      'bg-0': '#21222c', 'bg-1': '#242631', 'bg-2': '#282a36', 'bg-3': '#2d2f3d', 'bg-4': '#343746',
      'ink-0': '#ffffff', 'ink-1': '#e8e8e4', 'ink-2': '#dededa', 'ink-3': '#f8f8f2',
      'ink-4': '#cfd2dd', 'ink-5': '#b6b9c9', 'ink-6': '#6272a4',
      'ctl-bg': '#343746', sel: '#44475a', hover: '#343746', 'hover-soft': '#2d2f3d', 'hover-chip': '#3a3d4d',
      chip: '#3f4255', badge: '#4a4e63',
      accent: '#bd93f9', ok: '#50fa7b', warn: '#f1fa8c', err: '#ff5555',
      'ok-bg': '#1f3a2a', 'ok-bg-2': '#223327', 'ok-ink': '#8ef0a8', 'ok-line': '#2c5540', 'ok-line-2': '#37684e',
      'warn-bg': '#3b3a22', 'warn-bg-2': '#33321d', 'warn-line': '#4b4a2b',
      'err-bg': '#3b2323', 'err-bg-2': '#472828',
      'dot-off': '#52566b',
    },
  },
  {
    id: 'gruvbox', name: 'Gruvbox Dark', tokens: {
      bg: '#282828', panel: '#3c3836', card: '#3c3836',
      line: '#504945', 'line-soft': '#3c3836', 'line-strong': '#665c54',
      'line-card': '#453f3c', 'line-think': '#504945',
      fg: '#ebdbb2', dim: '#bdae93', mute: '#928374', 'code-bg': '#1d2021',
      'bg-0': '#1d2021', 'bg-1': '#232323', 'bg-2': '#282828', 'bg-3': '#32302f', 'bg-4': '#3c3836',
      'ink-0': '#fbf1c7', 'ink-1': '#f2e5bc', 'ink-2': '#ebdbb2', 'ink-3': '#d5c4a1',
      'ink-4': '#bdae93', 'ink-5': '#a89984', 'ink-6': '#928374',
      'ctl-bg': '#3c3836', sel: '#504945', hover: '#3c3836', 'hover-soft': '#32302f', 'hover-chip': '#423d3a',
      chip: '#4a443f', badge: '#574f48',
      accent: '#fe8019', ok: '#b8bb26', warn: '#fabd2f', err: '#fb4934',
      'ok-bg': '#32361f', 'ok-bg-2': '#2c301c', 'ok-ink': '#d5d98a', 'ok-line': '#4a522a', 'ok-line-2': '#5a6534',
      'warn-bg': '#3e3620', 'warn-bg-2': '#352f1b', 'warn-line': '#504529',
      'err-bg': '#3d2521', 'err-bg-2': '#482b26',
      'dot-off': '#665c54',
    },
  },
  {
    id: 'nord', name: 'Nord', tokens: {
      bg: '#2e3440', panel: '#3b4252', card: '#3b4252',
      line: '#4c566a', 'line-soft': '#3b4252', 'line-strong': '#5e6a80',
      'line-card': '#454e5e', 'line-think': '#4c566a',
      fg: '#d8dee9', dim: '#8e97ad', mute: '#616e88', 'code-bg': '#242933',
      'bg-0': '#242933', 'bg-1': '#2a303c', 'bg-2': '#2e3440', 'bg-3': '#343b48', 'bg-4': '#3b4252',
      'ink-0': '#eceff4', 'ink-1': '#e5e9f0', 'ink-2': '#d8dee9', 'ink-3': '#c4ccd9',
      'ink-4': '#aeb6c4', 'ink-5': '#8e97ad', 'ink-6': '#616e88',
      'ctl-bg': '#3b4252', sel: '#434c5e', hover: '#3b4252', 'hover-soft': '#343b48', 'hover-chip': '#414a5b',
      chip: '#434c5e', badge: '#4c566a',
      accent: '#88c0d0', ok: '#a3be8c', warn: '#ebcb8b', err: '#bf616a',
      'ok-bg': '#2f3b2c', 'ok-bg-2': '#2a3428', 'ok-ink': '#b7cf9f', 'ok-line': '#435540', 'ok-line-2': '#53664f',
      'warn-bg': '#3d3a2c', 'warn-bg-2': '#343227', 'warn-line': '#4e4a38',
      'err-bg': '#3b2b30', 'err-bg-2': '#46333a',
      'dot-off': '#5e6a80',
    },
  },
];

/** Acha o preset pelo id (ou null). */
export function presetById(id) {
  return PRESETS.find((p) => p && p.id === id) || null;
}
