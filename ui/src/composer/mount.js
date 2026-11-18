import { mount } from 'svelte';
import ModelPop from './ModelPop.svelte';
import CtxPop from './CtxPop.svelte';
import ForkPop from './ForkPop.svelte';
import Attachments from './Attachments.svelte';

/** Monta o pop de modelo no container do composer.
 *  `host` injeta o que o componente precisa — o componente não importa
 *  `main.js`, então não há ciclo. Retorna null sem o container (fallback
 *  legado continua valendo). */
export function mountModelPop(host) {
  const target = document.getElementById('modelpop-svelte');
  if (!target) return null;
  return mount(ModelPop, { target, props: { host } });
}

/** Monta o pop de contexto no container do composer (mesmo contrato). */
export function mountCtxPop(host) {
  const target = document.getElementById('ctxpop-svelte');
  if (!target) return null;
  return mount(CtxPop, { target, props: { host } });
}

/** Monta o picker de fork no container do composer (mesmo contrato). */
export function mountForkPop(host) {
  const target = document.getElementById('forkpop-svelte');
  if (!target) return null;
  return mount(ForkPop, { target, props: { host } });
}

/** Monta a linha de anexos no container `#attachrow` (mesmo contrato). */
export function mountAttachments(host) {
  const target = document.getElementById('attachrow');
  if (!target) return null;
  return mount(Attachments, { target, props: { host } });
}
