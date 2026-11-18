<script>
  /* Picker de fork (Fase 2). Sem imports do `main.js`: `items` espelha o host
     e é atualizado por `sync` — chamado pelo `main.js` em openForkPop. */
  let { host } = $props();

  // svelte-ignore state_referenced_locally: snapshot inicial; refresh via sync().
  let items = $state(host.snapshot([]));

  // pi-lens-ignore: lint/correctness/noUnusedVariables — consumido no template ({tr(...)})
  function tr(key, vars) {
    return host.t(key, vars);
  }

  /** Chamado pelo `main.js` (openForkPop). */
  export function sync(messages) {
    items = host.snapshot(messages || []);
  }
</script>

<div class="model-group">{tr('fork.header')}</div>
{#if !items.length}
  <div class="model-empty">{tr('fork.empty')}</div>
{/if}
{#each items as m (m.entryId)}
  <div
    class="model-row"
    title={m.title}
    role="button"
    tabindex="0"
    onclick={() => host.doFork(m.entryId)}
    onkeydown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        host.doFork(m.entryId);
      }
    }}
  >
    <span class="model-name">{m.label}</span>
    <span class="model-ctx">{m.short}</span>
  </div>
{/each}
