<script>
  /* Árvore de sessões da sidebar (Fase 3b). Sem imports do `main.js`: `snap`
     espelha o host e é atualizado por `sync` — chamado pelo `main.js` em
     `loadSessions`. Classes (.group, .sess…) vêm do `styles.css` global. */
  let { host } = $props();

  // pi-lens-ignore: lint/correctness/noUnusedVariables — consumido no template
  let snap = $state(host.snapshot());

  /** Chamado pelo `main.js` (loadSessions). */
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

{#if !snap.groups.length}
  <div class="empty">{snap.emptyLabel}</div>
{:else}
  {#each snap.groups as g (g.path)}
    <div class={'group' + (g.collapsed ? ' collapsed' : '')}>
      <div
        class="group-head"
        role="button"
        tabindex="0"
        onclick={() => host.toggleProject(g.path)}
        onkeydown={(e) => keyAct(e, () => host.toggleProject(g.path))}
      >
        <span class="caret">{g.caret}</span>
        <span class="proj-name" title={g.path}>{g.name}</span>
        {#if g.count}<span class="proj-count">{g.count}</span>{/if}
        <button
          class="tiny plus"
          title={g.newTitle}
          onclick={(e) => { e.stopPropagation(); host.newSession(g.path); }}
        >+</button>
        <button
          class="tiny"
          title={g.hideTitle}
          onclick={(e) => { e.stopPropagation(); host.hideProject(g.path); }}
        >{g.hideMark}</button>
      </div>
      <div class="sess-list">
        {#each g.rows as s (s.key)}
          <div
            class="sess"
            data-key={s.key}
            title={s.titleAttr}
            role="button"
            tabindex="0"
            onclick={() => host.open(g.path, s.key)}
            onkeydown={(e) => keyAct(e, () => host.open(g.path, s.key))}
          >
            <div class="sess-title">{s.title}</div>
            <div class="sess-meta">
              <span>{s.meta}</span>
              {#if s.children > 0}
                <span class="badge" title={s.childrenTitle}>{s.children}</span>
              {/if}
              <button
                class="tiny"
                title={s.trashTitle}
                onclick={(e) => { e.stopPropagation(); host.askDelete(g.path, s.key); }}
              >×</button>
            </div>
          </div>
        {/each}
        {#if g.hiddenCount > 0}
          <button class="sess-more" onclick={() => host.loadMore(g.path)}>{g.moreLabel}</button>
        {/if}
      </div>
    </div>
  {/each}
{/if}
