<script>
  /* Anexos do composer (Fase 5a). Sem imports do `main.js`: `snap` espelha o
     host e é atualizado por `sync` — chamado pelo `main.js` em
     `renderAttachments`. O container `#attachrow` tem a classe `hidden`
     controlada pelo main (como antes); aqui só o conteúdo. */
  let { host } = $props();

  // svelte-ignore state_referenced_locally: snapshot inicial; refresh via sync().
  // pi-lens-ignore: lint/correctness/noUnusedVariables — consumido no template
  let snap = $state(host.snapshot());

  /** Chamado pelo `main.js` (renderAttachments). */
  export function sync() {
    snap = host.snapshot();
  }
</script>

{#each snap as img (img.idx)}
  <div class="attach">
    <img src={img.src} alt={img.alt} />
    <button class="tiny" title={img.removeTitle} onclick={() => host.remove(img.idx)}>×</button>
  </div>
{/each}
