// Reexporta a config que mora em `ui/` (root do Vite, onde o plugin procura).
// Existe na raiz só para o language server do Svelte, que resolve o workspace
// root — uma única fonte do conteúdo, sem duplicar regras.
export { default } from './ui/svelte.config.js';
