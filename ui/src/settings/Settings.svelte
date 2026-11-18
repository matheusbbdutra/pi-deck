<script>
  /* Piloto Svelte da tela de Configurações.
     Sem imports do `main.js`: tudo entra pelo `host` injetado (evita ciclo e
     permite testar/migrar o resto depois). Estado local espelha `uiSettings`;
     escrita passa por `host.setSetting` / `host.setLang`. */
  let { host } = $props();

  /* Snapshot intencional: espelho local de `uiSettings`; a escrita volta por
     `host.setSetting`. Não é reativo a troca de `host`. */
  // svelte-ignore state_referenced_locally
  let flags = $state({ ...host.uiSettings });
  // svelte-ignore state_referenced_locally
  let lang = $state(host.getLangPref());

  /* Ler `lang` dentro do helper registra a dependência: trocar o idioma
     re-renderiza também os rótulos, não só o <select>.
     `void` evita o warning de expressão solta sem mudar a dependência. */
  function tr(key) {
    void lang;
    return host.t(key);
  }

  const groups = [
    {
      key: 'settings.group_transcript',
      items: [
        ['expandTools', 'settings.expand_tools'],
        ['expandThink', 'settings.expand_think'],
      ],
    },
    {
      key: 'settings.group_notify',
      items: [
        ['notifyDesktop', 'settings.notify_desktop'],
        ['notifySound', 'settings.notify_sound'],
      ],
    },
    { key: 'settings.group_project', items: [['showHidden', 'settings.show_hidden']] },
  ];

  function toggle(key, checked) {
    flags[key] = checked;
    host.setSetting(key, checked);
  }

  function pick(value) {
    lang = value;
    host.setLang(value);
  }
</script>

{#each groups as group (group.key)}
  <h5 class="group">{tr(group.key)}</h5>
  {#each group.items as [key, label] (key)}
    <label>
      <input type="checkbox" checked={flags[key]} onchange={(e) => toggle(key, e.currentTarget.checked)} />
      <span>{tr(label)}</span>
    </label>
  {/each}
{/each}

<h5 class="group">{tr('settings.group_appearance')}</h5>
<label>
  <span>{tr('settings.language')}</span>
  <select id="langsel" class="mfield" value={lang} onchange={(e) => pick(e.currentTarget.value)}>
    <option value="auto">{tr('settings.lang_auto')}</option>
    <option value="pt">{tr('settings.lang_pt')}</option>
    <option value="en">{tr('settings.lang_en')}</option>
  </select>
</label>

<style>
  .group {
    margin: 2px 0 -2px;
    font-size: 9.5px;
    letter-spacing: .06em;
    text-transform: uppercase;
    color: var(--mute);
    font-family: var(--mono);
    font-weight: 600;
  }
  .group:first-child { margin-top: 0; }
</style>
