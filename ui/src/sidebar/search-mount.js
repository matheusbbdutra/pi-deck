import { mount } from 'svelte';
import SearchResults from './SearchResults.svelte';

/** Monta os resultados da busca global no container `#searchresults`.
 *  `host` injeta snapshot/open/loadMore — o componente não importa `main.js`.
 *  Retorna null sem o container (o render legado de `runSearch` continua). */
export function mountSearchResults(host) {
  const target = document.getElementById('searchresults');
  if (!target) return null;
  return mount(SearchResults, { target, props: { host } });
}
