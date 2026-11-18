import { mount } from 'svelte';
import SessionTree from './SessionTree.svelte';

/** Monta a árvore de sessões no container `#sessions`.
 *  `host` injeta snapshot/ações — o componente não importa `main.js`, então não
 *  há ciclo. Retorna null sem o container (o render legado continua valendo). */
export function mountSessionTree(host) {
  const target = document.getElementById('sessions');
  if (!target) return null;
  return mount(SessionTree, { target, props: { host } });
}
