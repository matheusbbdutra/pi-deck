import { mount } from 'svelte';
import ModelPop from './ModelPop.svelte';
import CtxPop from './CtxPop.svelte';
import ForkPop from './ForkPop.svelte';
import Attachments from './Attachments.svelte';
import Palette from './Palette.svelte';
import CmdkList from './CmdkList.svelte';
import TypingIndicator from './TypingIndicator.svelte';

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

/** Monta a lista da palette de comandos no container `#palettelist`. */
export function mountPalette(host) {
  const target = document.getElementById('palettelist');
  if (!target) return null;
  return mount(Palette, { target, props: { host } });
}

/** Monta a lista do cmdk (Ctrl+K) no container `#cmdklist` (mesmo contrato). */
export function mountCmdkList(host) {
  const target = document.getElementById('cmdklist');
  if (!target) return null;
  return mount(CmdkList, { target, props: { host } });
}

/** Monta o indicador de digitação no container `#typing-svelte` (mesmo contrato).
 *  O markup legado fica em `#typing-legacy` e é escondido quando o mount funciona. */
export function mountTyping(host) {
  const target = document.getElementById('typing-svelte');
  if (!target) return null;
  return mount(TypingIndicator, { target, props: { host } });
}
