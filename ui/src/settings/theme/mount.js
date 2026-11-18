import { mount } from 'svelte';
import Theme from './Theme.svelte';

/** Monta o diálogo de Tema (Fase 1) no container do overlay.
 *  `host` injeta o que o componente precisa — o componente não importa
 *  `main.js`, então não há ciclo. Retorna null sem o container (fallback
 *  legado continua valendo). */
export function mountTheme(host) {
  const target = document.getElementById('theme-svelte');
  if (!target) return null;
  return mount(Theme, { target, props: { host } });
}
