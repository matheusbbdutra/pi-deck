import { mount } from 'svelte';
import TabBar from './TabBar.svelte';

/** Monta a barra de abas no container `#tabs`.
 *  `host` injeta snapshot/switchTab/closeTab — o componente não importa
 *  `main.js`, então não há ciclo. Retorna null sem o container (o render
 *  legado de `renderTabs` continua valendo). */
export function mountTabBar(host) {
  const target = document.getElementById('tabs');
  if (!target) return null;
  return mount(TabBar, { target, props: { host } });
}
