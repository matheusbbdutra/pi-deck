// Ponte: ferramentas (language server do Svelte) procuram o config do Vite em
// `ui/`, que é o root do app. A fonte única é `../vite.config.js` (com `root`
// absoluto, então o re-export não muda a resolução de caminhos).
export { default } from '../vite.config.js';
