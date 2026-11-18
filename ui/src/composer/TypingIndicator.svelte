<script>
  /* Indicador de digitação (Fase 5d). Sem imports do `main.js`: `snap` espelha o
     host e é atualizado por `sync` — chamado pelo `main.js` em `setTyping`.
     O container `#typing` tem o `hidden` controlado pelo main, como antes. */
  let { host } = $props();

  // svelte-ignore state_referenced_locally: snapshot inicial; refresh via sync().
  // pi-lens-ignore: lint/correctness/noUnusedVariables — consumido no template
  let snap = $state(host.snapshot());

  /** Chamado pelo `main.js` (setTyping). */
  export function sync() {
    snap = host.snapshot();
  }
</script>

{#if snap.visible}
  <span class="tdot"></span><span class="tdot"></span><span class="tdot"></span>
  <span class="tlabel">{snap.label}</span>
{/if}
