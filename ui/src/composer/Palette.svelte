<script>
  /* Palette de comandos `/` (Fase 5b). Sem imports do `main.js`: `snap` espelha
     o host e é atualizado por `sync` — chamado pelo `main.js` em
     `renderPalette` (inclusive a cada seta do teclado). O container `#palette`
     tem o `hidden` controlado pelo main, como antes. */
  let { host } = $props();

  // svelte-ignore state_referenced_locally: snapshot inicial; refresh via sync().
  // pi-lens-ignore: lint/correctness/noUnusedVariables — consumido no template
  let snap = $state(host.snapshot());

  /** Chamado pelo `main.js` (renderPalette). */
  export function sync() {
    snap = host.snapshot();
  }

  function keyAct(e, fn) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fn();
    }
  }
</script>

{#each snap.rows as r (r.idx)}
  <div
    class={'palette-row' + (r.sel ? ' sel' : '')}
    role="button"
    tabindex="0"
    onclick={() => host.pick(r.idx)}
    onkeydown={(e) => keyAct(e, () => host.pick(r.idx))}
  >
    <span class="pname">{r.name}</span>
    <span class="pdesc">{r.desc}</span>
    <span class="psrc">{r.src}</span>
  </div>
{/each}
