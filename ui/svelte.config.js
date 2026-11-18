import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// `vitePlugin` é campo suportado pelo svelte-check/svelte-language-server: com
// ele o tooling não precisa deduzir as opções lendo o `vite.config` (que fica na
// raiz). `preprocess` cobre CSS/TS nos componentes.
export default {
  preprocess: vitePreprocess(),
  vitePlugin: {},
};
