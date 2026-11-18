<script>
  /* Painel Missões (Fase 4b) — somente leitura, sem runner. Sem imports do
     `main.js`: `snap` espelha o host e é atualizado por `sync` — chamado pelo
     `main.js` em `renderMissions`. */
  let { host } = $props();

  // svelte-ignore state_referenced_locally: snapshot inicial; refresh via sync().
  // pi-lens-ignore: lint/correctness/noUnusedVariables — consumido no template
  let snap = $state(host.snapshot());

  /** Chamado pelo `main.js` (renderMissions). */
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
  <div class="history-head">{snap.head}</div>
  {#each snap.rows as m (m.key)}
    <div
      class="file-row"
      title={m.titleAttr}
      role="button"
      tabindex="0"
      onclick={() => host.open(m.key)}
      onkeydown={(e) => keyAct(e, () => host.open(m.key))}
    >
      <span class="file-name">{m.title}</span>
      <span class="file-dir">{m.status}</span>
      <span class="file-count">{m.runs}</span>
    </div>
  {/each}
{/if}
