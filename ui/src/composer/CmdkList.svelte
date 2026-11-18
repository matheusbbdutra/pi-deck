<script>
  /* Palette global Ctrl+K (Fase 5c). Sem imports do `main.js`: `snap` espelha o
     host e é atualizado por `sync` — chamado pelo `main.js` em `renderCmdk`
     (inclusive a cada seta). O container `#cmdklist` tem o `hidden` controlado
     pelo main; aqui só conteúdo (grupos + linhas). */
  let { host } = $props();

  // svelte-ignore state_referenced_locally: snapshot inicial; refresh via sync().
  // pi-lens-ignore: lint/correctness/noUnusedVariables — consumido no template
  let snap = $state(host.snapshot());

  /** Chamado pelo `main.js` (renderCmdk). */
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

{#if snap.empty}
  <div class="model-empty">{snap.emptyLabel}</div>
{:else}
  {#each snap.groups as g (g.label)}
    {#if g.rows.length}
      <div class="palette-group">{g.label}</div>
      {#each g.rows as r (r.idx)}
        <div
          class={'palette-row' + (r.sel ? ' sel' : '')}
          role="button"
          tabindex="0"
          onclick={() => host.pick(r.idx)}
          onkeydown={(e) => keyAct(e, () => host.pick(r.idx))}
        >
          <span class="pname">{r.title}</span>
          <span class="pdesc">{r.desc}</span>
          <span class="psrc">{r.src}</span>
        </div>
      {/each}
    {/if}
  {/each}
{/if}
