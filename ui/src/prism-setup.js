/* Os componentes do Prism (CJS) usam o `Prism` do escopo global — o pacote não
   importa o core. Em bundle (sem o `global` do Node) nada define esse global, então
   ele é fixado aqui: ESM avalia este módulo antes dos componentes importados em
   `highlight.js`, e é isso que os deixa carregar. */
import Prism from 'prismjs/components/prism-core';

globalThis.Prism = Prism;

export default Prism;
