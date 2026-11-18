<script>
  /* Diálogo de Tema (Fase 1 da migração Svelte).
     Sem imports do `main.js`: tudo entra pelo `host` injetado (evita ciclo).
     `active`/`json`/`note` são espelhos locais; a escrita volta por
     `host.applyPreset` / `host.applyJson` / `host.exportJson` / `host.resetAll`. */
  let { host } = $props();

  // svelte-ignore state_referenced_locally
  let active = $state(host.getActiveId());
  let json = $state('');
  let note = $state('');

  /* `host.t` lê o idioma atual na chamada: sem estado local de idioma o
     componente também não depende de `getLangPref` (trocar idioma exige abrir
     o Settings, que fecha este overlay). */
  // pi-lens-ignore: lint/correctness/noUnusedVariables — consumido no template ({tr(...)})
  function tr(key, vars) {
    return host.t(key, vars);
  }

  function pick(id, name) {
    const res = host.applyPreset(id);
    if (!res.error) {
      active = id;
      const p = host.presets.find((x) => x.id === id);
      json = JSON.stringify(p ? p.tokens : {}, null, 2);
    }
    note = host.note(res, name);
  }

  function apply() {
    const res = host.applyJson(json);
    if (!res.error) active = 'custom';
    note = host.note(res, null);
  }

  function exp() {
    const out = host.exportJson();
    json = out.json;
    note = host.note(out.res, host.t('theme.exported'));
  }

  function reset() {
    host.resetAll();
    active = 'sightdeck';
    json = '';
    note = host.t('theme.restored');
  }
</script>

<h5 class="tsec">{tr('theme.presets')}</h5>
<div class="theme-grid">
  {#each host.presets as p (p.id)}
    <button
      type="button"
      class="theme-card"
      class:active={active === p.id}
      title={tr('theme.use_preset', { name: p.name })}
      onclick={() => pick(p.id, p.name)}
    >
      <span class="swatches">
        <span class="sw" style="background:{p.tokens.bg || 'var(--bg)'}"></span>
        <span class="sw" style="background:{p.tokens.panel || 'var(--panel)'}"></span>
        <span class="sw" style="background:{p.tokens.accent || 'var(--accent)'}"></span>
      </span>
      <span class="theme-name">{p.name}</span>
      {#if active === p.id}<span class="theme-on">{tr('theme.active')}</span>{/if}
    </button>
  {/each}
</div>

<h5 class="tsec">{tr('theme.custom')}</h5>
<textarea
  class="theme-json"
  bind:value={json}
  spellcheck="false"
  placeholder={'{"bg":"#0f1115","accent":"#7aa2f7"}'}
></textarea>
<div class="theme-row">
  <button type="button" class="ghost" onclick={apply}>{tr('common.apply')}</button>
  <button type="button" class="ghost" onclick={exp}>{tr('common.export_current')}</button>
  <button type="button" class="ghost" onclick={reset}>{tr('common.reset')}</button>
</div>
<div class="theme-note">{note || tr('theme.paste_note')}</div>

<style>
  .tsec {
    margin: 2px 0 8px;
    font-size: 9.5px;
    letter-spacing: .06em;
    text-transform: uppercase;
    color: var(--mute);
    font-family: var(--mono);
    font-weight: 600;
  }
  .theme-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 8px;
    margin: 0 0 14px;
  }
  .theme-card {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    background: var(--bg-1);
    border: 1px solid var(--line);
    border-radius: 6px;
    color: var(--fg);
    font-family: var(--mono);
    font-size: 11px;
    cursor: pointer;
    text-align: left;
  }
  .theme-card:hover { border-color: var(--accent); }
  .theme-card.active { border-color: var(--accent); background: var(--sel); }
  .swatches { display: flex; flex: none; }
  .sw {
    width: 14px;
    height: 14px;
    border-radius: 3px;
    border: 1px solid var(--line-strong);
    margin-right: -4px;
  }
  .theme-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .theme-on {
    flex: none;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: .06em;
    color: var(--accent);
  }
  .theme-row { display: flex; gap: 8px; margin: 8px 0 0; }
</style>
