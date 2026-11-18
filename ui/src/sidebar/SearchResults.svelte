<script>
  /* Resultados da busca global (Fase 3c). Sem imports do `main.js`: `snap`
     espelha o host e é atualizado por `sync` — chamado pelo `main.js` em
     `runSearch`. Classes (.sess, .snippet…) vêm do `styles.css` global. */
  let { host } = $props();

  // svelte-ignore state_referenced_locally: snapshot inicial; refresh via sync().
  // pi-lens-ignore: lint/correctness/noUnusedVariables — consumido no template
  let snap = $state(host.snapshot());

  /** Chamado pelo `main.js` (runSearch). */
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

{#each snap.rows as r (r.key)}
  <div
    class="sess"
    data-key={r.key}
    title={r.titleAttr}
    role="button"
    tabindex="0"
    onclick={() => host.open(r.key)}
    onkeydown={(e) => keyAct(e, () => host.open(r.key))}
  >
    <div class="sess-title">{r.title}</div>
    {#if r.snippet}<div class="snippet">{r.snippet}</div>{/if}
    <div class="sess-meta">
      <span>{r.meta}</span>
      {#if r.tools}<span class="badge">{r.tools}</span>{/if}
      {#if r.hasError}<span class="badge">{r.errorLabel}</span>{/if}
    </div>
  </div>
{/each}
{#if snap.showMore}
  <button class="sess-more" onclick={() => host.loadMore()}>{snap.moreLabel}</button>
{/if}
{#if snap.empty}
  <div class="empty">{snap.emptyLabel}</div>
{/if}
