<script>
  /* Painel Subagents (Fase 4d). Sem imports do `main.js`: os dados vêm do host e
     o recálculo dos tempos é reativo — `now` avança 1 s e `snap` deriva dele, sem
     repintar a lista inteira (o `{#each}` com key preserva os nós e o scroll). */
  let { host } = $props();

  let version = $state(0);
  let now = $state(Date.now());

  // pi-lens-ignore: lint/correctness/noUnusedVariables — consumido no template
  const snap = $derived.by(() => {
    void version;              // registra a dependência de sync()
    return host.snapshot(now); // recalcula tempos a cada tique
  });

  /* Relógio só enquanto há run ao vivo; encerrado, o efeito limpa o timer. */
  $effect(() => {
    if (!snap.runs.length) return;
    const id = setInterval(() => { now = Date.now(); }, 1000);
    return () => clearInterval(id);
  });

  /** Chamado pelo `main.js` (paintSubs). */
  export function sync() {
    version += 1;
    now = Date.now();
  }

  function keyAct(e, fn) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fn();
    }
  }
</script>

{#if snap.empty}
  {#if snap.warn}
    <div class="warn-banner">{snap.emptyLabel}</div>
  {:else}
    <div class="empty">{snap.emptyLabel}</div>
  {/if}
{:else}
  {#each snap.runs as run (run.id || run.label)}
    <div class="run" data-state={run.state}>
      <div class="run-head">
        <span class="run-label">{run.label}</span>
        <span class={'state state-' + run.state}>{run.state}</span>
        <span class="tool-right run-time">{run.time}</span>
      </div>
      {#each run.children as ch (ch.key)}
        <div class="child" data-state={ch.state}>
          <b>{ch.label}</b>
          <span> · {ch.state}</span>
          {#if ch.model}<span> · {ch.model}</span>{/if}
          {#if ch.thinking}<span> · {ch.thinking}</span>{/if}
          <span class="child-time">{ch.time ? ' · ' + ch.time : ''}</span>
        </div>
      {/each}
    </div>
  {/each}
  {#if snap.history.length}
    <div class="history-head">{snap.historyHead}</div>
    {#each snap.history as c (c.id)}
      <div
        class="run clickable"
        title={c.id}
        role="button"
        tabindex="0"
        onclick={() => host.openChild(c.id)}
        onkeydown={(e) => keyAct(e, () => host.openChild(c.id))}
      >
        <div class="run-head">
          <span class="run-label">{c.label}</span>
          <span class={'state ' + c.stateClass}>{c.stateText}</span>
          <span class="tool-right">{c.meta}</span>
        </div>
      </div>
    {/each}
  {/if}
{/if}
