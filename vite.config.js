import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Export em OBJETO (não função): o language server do Svelte lê `plugins` direto
// do export e trata config-função como "sem configuração do Svelte".
export default defineConfig({
  root: fileURLToPath(new URL('./ui', import.meta.url)),
  // Só `ui/src/settings/**` é Svelte por enquanto (piloto): o resto segue DOM puro.
  plugins: [svelte()],
  // Build E2E: antes vinha de `--mode e2e`; como o export agora é estático,
  // o script marca por env (`E2E=1 npm run build:ui:e2e`).
  define: { __WDIO_E2E__: JSON.stringify(process.env.E2E === '1') },
  resolve: {
    // Uma instância do runtime Svelte mesmo com o plugin em `node_modules`.
    dedupe: ['svelte'],
    // Svelte 5 separa build client/SSR: sem `browser` o vitest resolve
    // `index-server.js` e `mount()` não existe (lifecycle_function_unavailable).
    conditions: ['browser'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  // Vitest herda o `root` acima: os testes ficam na raiz do repo, não em `ui/`.
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['tests/**/*.test.mjs'],
  },
  server: {
    port: 1420,
    strictPort: true,
  },
});
