<script>
  /* Pop de contexto (Fase 2). Sem imports do `main.js`: `snap` espelha o host
     e é atualizado por `sync` — chamado pelo `main.js` nos mesmos pontos que
     repintavam o DOM legado (renderCtxPop). Blocos vêm ordenados do snapshot. */
  let { host } = $props();

  // svelte-ignore state_referenced_locally: snapshot inicial; refresh via sync().
  // pi-lens-ignore: lint/correctness/noUnusedVariables — consumido no template ({#each snap.blocks}, {#if snap.empty})
  let snap = $state(host.snapshot());

  // pi-lens-ignore: lint/correctness/noUnusedVariables — consumido no template ({tr(...)})
  function tr(key, vars) {
    return host.t(key, vars);
  }

  /** Chamado pelo `main.js` (renderCtxPop). */
  export function sync() {
    snap = host.snapshot();
  }

  // pi-lens-ignore: lint/correctness/noUnusedVariables — usado no onchange do <select>
  async function onLimit(e) {
    snap = await host.saveLimit(e.currentTarget.value);
  }
</script>

{#each snap.blocks as b, i (i)}
  {#if b.t === 'row'}
    <div class="ctx-row"><div class="k">{b.k}</div><div class="v" class:dim={b.dim}>{b.v}</div></div>
  {:else if b.t === 'alert'}
    <div class="ctx-alert {b.kind}">{b.text}</div>
  {:else if b.t === 'limit'}
    <div class="ctx-row">
      <div class="k">{tr('ctx.compact_at')}</div>
      <select
        class="ctx-sel"
        title={b.limit.title}
        value={b.limit.value}
        disabled={b.limit.disabled}
        onchange={onLimit}
      >
        {#each b.limit.options as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
      </select>
    </div>
  {:else if b.t === 'agg'}
    <div class="ctx-total"><span>{b.agg.totalLabel}</span><span>{b.agg.totalText}</span></div>
    {#each b.agg.rows as r (r.title)}
      <div class="ctx-sess" title={r.title}>
        <span class="n">{r.n}</span><span class={'m' + (r.cls ? ' ' + r.cls : '')}>{r.m}</span>
      </div>
    {/each}
  {/if}
{/each}
{#if snap.empty && !snap.blocks.length}
  <div class="model-empty">{tr('panel.no_stats')}</div>
{/if}
