<script>
  /* Barra de abas (Fase 3). Sem imports do `main.js`: `items` espelha o host
     e é atualizado por `sync` — chamado pelo `main.js` em todo `renderTabs`.
     Classes (.tab, .tab-dot…) vêm do `styles.css` global. */
  let { host } = $props();

  // pi-lens-ignore: lint/correctness/noUnusedVariables — consumido no template ({#each items})
  let items = $state(host.snapshot());

  /** Chamado pelo `main.js` (renderTabs). */
  export function sync() {
    items = host.snapshot();
  }
</script>

{#each items as t (t.key)}
  <div
    class={'tab' + (t.active ? ' active' : '')}
    title={t.titleAttr}
    role="button"
    tabindex="0"
    onclick={() => host.switchTab(t.key)}
    onkeydown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        host.switchTab(t.key);
      }
    }}
  >
    <span class={'tab-dot' + t.dot}></span>
    <span class="tab-proj">{t.project}</span>
    <span class="tab-title">{t.title}</span>
    <button class="tab-close" onclick={(e) => { e.stopPropagation(); host.closeTab(t.key); }}>✕</button>
  </div>
{/each}
