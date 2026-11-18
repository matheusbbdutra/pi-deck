import { mount } from 'svelte';
import Settings from './Settings.svelte';

/** Monta a tela de Configurações (piloto Svelte) no container do popover.
 *  `host` injeta o que o componente precisa — o componente não importa
 *  `main.js`, então não há ciclo e a migração futura pode reusar o mesmo host. */
export function mountSettings(host) {
  const target = document.getElementById('settings-general');
  if (!target) return null;
  return mount(Settings, { target, props: { host } });
}
