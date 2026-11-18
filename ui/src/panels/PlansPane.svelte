<script>
  /* Painel Plano (Fase 4a). Sem imports do `main.js`: `snap` espelha o host e é
     atualizado por `sync` — chamado pelo `main.js` em `renderPlans`.
     Classes (.plan-item, .plan-bar…) vêm do `styles.css` global. */
  let { host } = $props();

  // svelte-ignore state_referenced_locally: snapshot inicial; refresh via sync().
  // pi-lens-ignore: lint/correctness/noUnusedVariables — consumido no template
  let snap = $state(host.snapshot());

  /** Chamado pelo `main.js` (renderPlans). */
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
  <div class="empty">{snap.empty}</div>
{:else}
  {#each snap.rows as r (r.file)}
    <div
      class="plan-item"
      title={r.title}
      role="button"
      tabindex="0"
      onclick={() => host.open(r.file)}
      onkeydown={(e) => keyAct(e, () => host.open(r.file))}
    >
      <div class="file-row">
        <span class="file-name">{r.name}</span>
        {#if r.source}<span class="plan-source">{r.source}</span>{/if}
        {#if r.current}<span class="plan-current">{r.current}</span>{/if}
        <span class="file-count">{r.count}</span>
      </div>
      <div class="plan-bar"><div class="plan-bar-fill" style="width:{r.pct}%"></div></div>
    </div>
  {/each}
{/if}
