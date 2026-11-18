<script>
  /* Painel Git (Fase 4c). Sem imports do `main.js`: `snap` espelha o host e é
     atualizado por `sync` — chamado pelo `main.js` em `renderGit`. O texto do
     commit NÃO volta pelo snapshot a cada tecla: `value` só é aplicado quando o
     painel re-renderiza de fato (ação/edição), então o cursor não salta. */
  let { host } = $props();

  // svelte-ignore state_referenced_locally: snapshot inicial; refresh via sync().
  // pi-lens-ignore: lint/correctness/noUnusedVariables — consumido no template
  let snap = $state(host.snapshot());

  /** Chamado pelo `main.js` (renderGit). */
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
  <div class="history-head">
    <span>{snap.head.branch}</span>
    <span> · ↑{snap.head.ahead} ↓{snap.head.behind}</span>
    <span> · {snap.head.count} arquivo(s) </span>
    <span class="git-add">+{snap.head.add}</span>
    <span> </span>
    <span class="git-del">−{snap.head.del}</span>
  </div>
  {#if snap.cwd}<div class="file-dir">{snap.cwd}</div>{/if}

  <div class="git-bar">
    <button class="ghost" title={snap.labels.hintReload} onclick={() => host.reload()}>{snap.labels.reload}</button>
    <button
      class="ghost"
      title={snap.labels.hintDiscard}
      disabled={!snap.selCount}
      onclick={() => host.discard()}
    >{snap.labels.discard}</button>
    <button class="ghost" title={snap.labels.hintStash} onclick={() => host.stash()}>{snap.labels.stash}</button>
    <button class="ghost" title={snap.labels.hintStashPop} onclick={() => host.stashPop()}>{snap.labels.stashPop}</button>
    <button class="ghost" title={snap.labels.hintPull} onclick={() => host.pull()}>{snap.labels.pull}</button>
  </div>

  {#if !snap.files.length}
    <div class="empty">{snap.cleanLabel}</div>
  {/if}
  {#each snap.files as f (f.path)}
    <div
      class="file-row"
      title={f.titleAttr}
      role="button"
      tabindex="0"
      onclick={() => host.toggleSel(f.path)}
      onkeydown={(e) => keyAct(e, () => host.toggleSel(f.path))}
    >
      <input
        type="checkbox"
        checked={f.selected}
        title={snap.labels.selectTitle}
        onclick={(e) => e.stopPropagation()}
        onchange={() => host.toggleSel(f.path)}
      />
      <span class="file-name">{f.name}</span>
      <span class="file-dir">{f.dir}</span>
      <span class="file-count">{f.status}</span>
      {#if f.add !== null || f.del !== null}
        <span class="git-add">+{f.add || 0}</span>
        <span class="git-del">−{f.del || 0}</span>
      {/if}
      <button
        class="ghost"
        title={snap.labels.diffTitle}
        onclick={(e) => { e.stopPropagation(); host.openDiff(f.path); }}
      >diff</button>
    </div>
  {/each}

  {#if snap.note}
    <div class="empty" style={snap.noteErr ? 'color: var(--err)' : ''}>{snap.note}</div>
  {/if}

  <div class="git-composer">
    <textarea
      id="gitmsg"
      placeholder={snap.labels.msgPh}
      value={snap.msg}
      oninput={(e) => host.setMsg(e.currentTarget.value)}
      onkeydown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          host.commit(false);
        }
      }}
    ></textarea>
    <div class="git-bar">
      <label class="git-check" title={snap.labels.hintAmend}>
        <input type="checkbox" checked={snap.amend} onchange={(e) => host.setFlag('amend', e.currentTarget.checked)} />
        <span>amend</span>
      </label>
      <label class="git-check" title={snap.labels.hintLease}>
        <input type="checkbox" checked={snap.lease} onchange={(e) => host.setFlag('lease', e.currentTarget.checked)} />
        <span>--force-with-lease</span>
      </label>
      <button class="primary" title={snap.labels.hintCommit} onclick={() => host.commit(false)}>commit</button>
      <button class="ghost" title={snap.labels.commitPushTitle} onclick={() => host.commit(true)}>commit &amp; push</button>
      <button class="ghost" title={snap.labels.pushTitle} onclick={() => host.push()}>push</button>
    </div>
  </div>
{/if}
