/* i18n PT/EN com auto-detect.
 * Fonte única para o chrome da UI. `main.js` e `tool-cards.js` usam `t()`;
 * estáticos do `index.html` via `applyStaticI18n()` (por id, sem data-i18n).
 * Persistência: `localStorage['lang']` ('pt'|'en'). Default: navigator.language
 * pt-* -> 'pt', resto -> 'en'. Seguro sem DOM/storage (testes/jsdom).
 */
export const LANGS = ['pt', 'en'];

export function detectLang() {
  try {
    const n = (typeof navigator !== 'undefined' && (navigator.language || navigator.userLanguage)) || '';
    return String(n).toLowerCase().startsWith('pt') ? 'pt' : 'en';
  } catch { return 'en'; }
}

export function getLang() {
  try {
    const s = localStorage.getItem('lang');
    if (s === 'pt' || s === 'en') return s;
    if (s === 'auto' || s == null) return detectLang();
  } catch { /* sem storage */ }
  return detectLang();
}

export function getLangPref() {
  try {
    const s = localStorage.getItem('lang');
    if (s === 'pt' || s === 'en' || s === 'auto') return s;
  } catch { /* sem storage */ }
  return 'auto';
}

export function setLang(lang) {
  const pref = lang === 'pt' || lang === 'en' || lang === 'auto' ? lang : 'auto';
  const l = pref === 'auto' ? detectLang() : pref;
  try { localStorage.setItem('lang', pref); } catch { /* sem storage */ }
  try { document.documentElement.lang = l === 'pt' ? 'pt-BR' : 'en'; } catch { /* sem DOM */ }
  return l;
}

function fmt(tpl, vars) {
  let s = String(tpl == null ? '' : tpl);
  if (!vars) return s;
  for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(String(vars[k]));
  return s;
}

export const STRINGS = {
  pt: {
    'status.disconnected': 'desconectado',
    'status.connected': 'conectado',
    'status.working': 'trabalhando',
    'status.readonly': 'somente leitura',
    'status.reloading': 'recarregando…',
    'status.thinking': 'pensando…',
    'status.ghost_unlocked_ok': 'turno encerrado sem aviso do pi — indicador destravado',
    'status.ghost_unlocked_fail': 'o pi não respondeu ao estado do turno — indicador destravado',

    'sidebar.sessions': 'Sessões',
    'sidebar.search_ph': 'buscar nas sessões…',
    'sidebar.tool_filter_ph': 'tool (ex: edit)',
    'sidebar.errors_only': 'erros',
    'sidebar.no_sessions': 'nenhuma sessão em ~/.pi/agent/sessions',
    'sidebar.loading': 'carregando…',
    'sidebar.no_project': 'sem projeto',
    'sidebar.untitled': 'sem título',
    'sidebar.load_more': 'carregar mais ({n})',
    'sidebar.show_more': 'mostrar mais ({n})',
    'sidebar.matches': 'trecho(s)',
    'sidebar.error_badge': 'erro',

    'empty.new_session': 'Sessão nova — escreva abaixo para começar.',
    'empty.no_session_a': 'Selecione uma sessão na barra à esquerda',
    'empty.no_session_b': 'ou crie uma nova com ',
    'empty.no_session_c': ' no projeto.',

    'composer.placeholder': 'mensagem para o pi  ·  Enter envia · Ctrl+Enter quebra linha',
    'composer.cmd_ph': 'comando, /model …  ·  Esc fecha',
    'composer.send': 'Enviar (Enter)',
    'composer.enqueue': 'Enfileirar mensagem (turno rodando)',
    'composer.stop': 'Interromper o turno (Esc)',
    'composer.model_search_ph': 'Search models…',
    'composer.thinking': 'Thinking',
    'composer.fork_from': 'fork a partir de… · cria sessão nova · a original é preservada',
    'composer.no_answer': 'nenhuma resposta para copiar',
    'composer.copy_fail': 'falha ao copiar: {e}',
    'composer.no_session': 'sem sessão aberta',
    'composer.nothing_fork': 'nada para fork: sem mensagens do usuário nesta sessão',
    'composer.notext': '(sem texto)',
    'composer.palette_recent': '↑↓ navegar · Enter executar · Esc fechar · sem busca: recentes primeiro',
    'composer.palette_complete': '↑↓ selecionar · Tab completar · Enter executar · Esc fechar',

    'panel.subs': 'Subagents',
    'panel.plans': 'Plano',
    'panel.git': 'Git',
    'panel.no_subs': 'nenhum subagent',
    'panel.no_subs_ext': 'pi-subagents não carregou nesta sessão (possível conflito de tool). Veja ⚙ → Pacotes e MCP.',
    'panel.no_plans': 'nenhum plano',
    'panel.no_plans_found': 'nenhum plano encontrado (plans/, docs/spec, PLAN.md…)',
    'panel.no_checklist': 'sem checklist',
    'panel.no_git': 'sem repositório git',
    'panel.git_clean': 'repositório limpo — nenhuma mudança no worktree',
    'panel.no_warnings': 'nenhum aviso nesta sessão',
    'panel.no_lines': 'sem linhas RPC ainda',
    'panel.no_missions': 'nenhuma missão',
    'panel.no_stats': 'sem estatísticas ainda',
    'panel.transcript_loading': 'carregando transcript…',
    'panel.transcript_empty': 'transcript vazio (arquivo sem mensagens)',
    'panel.starting': 'iniciando… {id}',
    'panel.thinking_label': 'pensando…',

    'history.load_more': 'carregar anteriores ({left} de {total})',
    'history.loading': 'carregando…',

    'settings.expand_tools': 'Ferramentas expandidas',
    'settings.expand_think': 'Thinking expandido',
    'settings.show_hidden': 'Mostrar projetos ocultos',
    'settings.notify_desktop': 'Notificar término em 2º plano',
    'settings.notify_sound': 'Som ao terminar em 2º plano',
    'settings.instrument': 'Instrumentar hooks',
    'settings.theme': 'Tema',
    'settings.packages': 'Pacotes e MCP',
    'settings.debug': 'Debug',
    'settings.about': 'Sobre',
    'settings.check_update': 'Verificar atualização',
    'settings.update_ext': 'Atualizar extensões',
    'settings.update_pi': 'Atualizar pi',
    'settings.language': 'Idioma',
    'settings.lang_pt': 'Português',
    'settings.lang_en': 'English',
    'settings.lang_auto': 'Auto (navegador)',

    'common.loading': 'carregando…',
    'common.updating': 'Atualizar',
    'common.refresh': 'Atualizar',
    'common.back': '← voltar',
    'common.close': 'Fechar',
    'common.cancel': 'Cancelar',
    'common.execute': 'Executar',
    'common.download': 'Baixar',
    'common.dismiss': 'Dispensar',
    'common.clear': 'limpar',
    'common.apply': 'aplicar',
    'common.export_current': 'exportar atual',
    'common.reset': 'resetar',
    'common.add_test': 'Adicionar e testar',
    'common.remove_by_name': 'Remover pelo nome',
    'common.save': 'Salvar',

    'pkgs.title': 'Pacotes',
    'pkgs.installed': 'Instalados',
    'pkgs.catalog': 'Catálogo',
    'pkgs.mcp': 'MCP',
    'pkgs.hooks': 'Hooks',
    'pkgs.catalog_ph': 'filtrar o catálogo (npm keywords:pi-package)…',
    'pkgs.querying': 'consultando registry.npmjs.org…',
    'pkgs.query_fail': 'falha ao consultar o registry: {e}',
    'pkgs.none_found': 'nada encontrado',
    'pkgs.no_mcp': 'nenhum servidor MCP configurado',
    'pkgs.removing': 'removendo…',
    'pkgs.installing': 'instalando {spec}…',
    'pkgs.removing_spec': 'removendo {spec}…',
    'pkgs.need_name': 'informe o nome',
    'pkgs.need_target': 'informe uma URL ou um comando',
    'pkgs.running': 'executando…',
    'pkgs.hooks_empty': '(sem registros ainda) — dispare uma mensagem e volte aqui',
    'pkgs.logger_on': 'logger ativo · ',
    'pkgs.logger_off': 'logger inativo · ',

    'mcp.name_ph': 'nome do servidor',
    'mcp.target_ph': 'https://… (HTTP) ou comando: npx -y pacote',
    'mcp.args_ph': 'argumentos extras (ex.: /home/usuario)',
    'mcp.add_env': '+ variável de ambiente',
    'mcp.project_scope': 'projeto (.pi/mcp.json)',
    'mcp.raw_json': 'JSON cru',
    'mcp.add_server': 'Adicionar servidor',
    'mcp.remove': 'Remover',

    'prov.title': 'Login — escolha o provedor',
    'prov.search_ph': 'filtrar provedores…',
    'prov.loading': 'carregando provedores…',
    'prov.none': 'nenhum provedor encontrado',
    'prov.no_cred': 'sem credencial',
    'prov.current': 'atual: {p}',
    'prov.login': 'logar {p}',
    'prov.auth_ok': 'auth ok',

    'theme.restored': "tema padrão restaurado (localStorage['theme'] removido)",
    'theme.paste_note': 'cole um JSON de tokens (--bg, --accent, …) e clique em aplicar',

    'about.body': 'O sightdeck é um cliente desktop para o pi — ele não instala nem atualiza o pi sozinho: os botões de atualização chamam pi update.',

    'update.available': 'Atualização disponível: {tag}',
    'update.check_fail': 'falha ao verificar',
    'update.running': 'rodando… (pode demorar)',

    'git.pull': 'pull',
    'git.discard': 'descartar',
    'git.stash': 'stash',
    'git.stash_pop': 'stash pop',
    'git.commit': 'commit',
    'git.commit_push': 'commit & push',
    'git.push': 'push',
    'git.reload': 'atualizar',
    'git.commit_msg_ph': 'mensagem do commit · Ctrl+Enter commita',
    'git.amend': 'amend',
    'git.force_lease': 'force-with-lease',
    'git.empty_msg': 'mensagem vazia — nada foi commitado',
    'git.commit_push_done': 'commit {h} feito, push falhou — {e}',
    'git.discard_confirm': 'descartar {n} arquivo(s)?\n\n{files}\ne excluir {extra} extra(s) não listado(s)?',
    'git.push_force_confirm': 'git push --force-with-lease\n\nno repositório {cwd}?',

    'tools.lines': 'linhas',
    'tools.matches': 'matches',
    'tools.entries': 'entradas',
    'tools.truncated': '\n… saída truncada ({cut} de {total} linhas)',
    'tools.thinking': 'thinking',
    'tools.unified': 'vista unificada',
    'tools.split': 'vista dividida',
    'tools.undo_hunk': 'desfazer hunk',
    'tools.copy_path': 'copiar caminho',
    'tools.open': 'abrir',
    'tools.diff_readonly': 'git diff · somente leitura',
    'tools.reading_diff': 'lendo diff…',
    'tools.no_changes': 'sem alterações no worktree',
    'tools.no_diff': 'sem diff (arquivo novo ou conteúdo não registrado)',
    'tools.diff_fail': 'git diff: {e}',

    'term.in': 'terminal em {cwd} · sessão em {sess} — use reiniciar',
    'term.dir': 'diretório do terminal ativo',
    'term.tab': 'terminal {n}',
    'term.ended': '[terminou]',
    'term.close_tab': 'fechar esta aba',
    'term.new': 'Novo terminal',
    'term.restart': 'reiniciar',
    'term.close': 'Fechar o terminal (Ctrl+`)',
  },
  en: {
    'status.disconnected': 'disconnected',
    'status.connected': 'connected',
    'status.working': 'working',
    'status.readonly': 'read-only',
    'status.reloading': 'reloading…',
    'status.thinking': 'thinking…',
    'status.ghost_unlocked_ok': 'turn ended without pi notice — indicator unlocked',
    'status.ghost_unlocked_fail': 'pi did not answer turn state — indicator unlocked',

    'sidebar.sessions': 'Sessions',
    'sidebar.search_ph': 'search sessions…',
    'sidebar.tool_filter_ph': 'tool (e.g. edit)',
    'sidebar.errors_only': 'errors',
    'sidebar.no_sessions': 'no sessions in ~/.pi/agent/sessions',
    'sidebar.loading': 'loading…',
    'sidebar.no_project': 'no project',
    'sidebar.untitled': 'untitled',
    'sidebar.load_more': 'load more ({n})',
    'sidebar.show_more': 'show more ({n})',
    'sidebar.matches': 'match(es)',
    'sidebar.error_badge': 'error',

    'empty.new_session': 'New session — write below to start.',
    'empty.no_session_a': 'Select a session in the left bar',
    'empty.no_session_b': 'or create a new one with ',
    'empty.no_session_c': ' in the project.',

    'composer.placeholder': 'message for pi  ·  Enter sends · Ctrl+Enter new line',
    'composer.cmd_ph': 'command, /model …  ·  Esc closes',
    'composer.send': 'Send (Enter)',
    'composer.enqueue': 'Enqueue message (turn running)',
    'composer.stop': 'Interrupt the turn (Esc)',
    'composer.model_search_ph': 'Search models…',
    'composer.thinking': 'Thinking',
    'composer.fork_from': 'fork from… · creates a new session · the original is kept',
    'composer.no_answer': 'no answer to copy',
    'composer.copy_fail': 'copy failed: {e}',
    'composer.no_session': 'no open session',
    'composer.nothing_fork': 'nothing to fork: no user messages in this session',
    'composer.notext': '(no text)',
    'composer.palette_recent': '↑↓ navigate · Enter run · Esc close · no search: recent first',
    'composer.palette_complete': '↑↓ select · Tab complete · Enter run · Esc close',

    'panel.subs': 'Subagents',
    'panel.plans': 'Plan',
    'panel.git': 'Git',
    'panel.no_subs': 'no subagents',
    'panel.no_subs_ext': 'pi-subagents did not load in this session (possible tool conflict). See ⚙ → Packages & MCP.',
    'panel.no_plans': 'no plans',
    'panel.no_plans_found': 'no plans found (plans/, docs/spec, PLAN.md…)',
    'panel.no_checklist': 'no checklist',
    'panel.no_git': 'no git repository',
    'panel.git_clean': 'clean tree — no worktree changes',
    'panel.no_warnings': 'no warnings in this session',
    'panel.no_lines': 'no RPC lines yet',
    'panel.no_missions': 'no missions',
    'panel.no_stats': 'no stats yet',
    'panel.transcript_loading': 'loading transcript…',
    'panel.transcript_empty': 'empty transcript (file has no messages)',
    'panel.starting': 'starting… {id}',
    'panel.thinking_label': 'thinking…',

    'history.load_more': 'load older ({left} of {total})',
    'history.loading': 'loading…',

    'settings.expand_tools': 'Expanded tools',
    'settings.expand_think': 'Expanded thinking',
    'settings.show_hidden': 'Show hidden projects',
    'settings.notify_desktop': 'Notify on background finish',
    'settings.notify_sound': 'Sound on background finish',
    'settings.instrument': 'Instrument hooks',
    'settings.theme': 'Theme',
    'settings.packages': 'Packages & MCP',
    'settings.debug': 'Debug',
    'settings.about': 'About',
    'settings.check_update': 'Check for updates',
    'settings.update_ext': 'Update extensions',
    'settings.update_pi': 'Update pi',
    'settings.language': 'Language',
    'settings.lang_pt': 'Português',
    'settings.lang_en': 'English',
    'settings.lang_auto': 'Auto (browser)',

    'common.loading': 'loading…',
    'common.updating': 'Update',
    'common.refresh': 'Refresh',
    'common.back': '← back',
    'common.close': 'Close',
    'common.cancel': 'Cancel',
    'common.execute': 'Run',
    'common.download': 'Download',
    'common.dismiss': 'Dismiss',
    'common.clear': 'clear',
    'common.apply': 'apply',
    'common.export_current': 'export current',
    'common.reset': 'reset',
    'common.add_test': 'Add & test',
    'common.remove_by_name': 'Remove by name',
    'common.save': 'Save',

    'pkgs.title': 'Packages',
    'pkgs.installed': 'Installed',
    'pkgs.catalog': 'Catalog',
    'pkgs.mcp': 'MCP',
    'pkgs.hooks': 'Hooks',
    'pkgs.catalog_ph': 'filter catalog (npm keywords:pi-package)…',
    'pkgs.querying': 'querying registry.npmjs.org…',
    'pkgs.query_fail': 'registry query failed: {e}',
    'pkgs.none_found': 'nothing found',
    'pkgs.no_mcp': 'no MCP servers configured',
    'pkgs.removing': 'removing…',
    'pkgs.installing': 'installing {spec}…',
    'pkgs.removing_spec': 'removing {spec}…',
    'pkgs.need_name': 'enter a name',
    'pkgs.need_target': 'enter a URL or a command',
    'pkgs.running': 'running…',
    'pkgs.hooks_empty': '(no records yet) — send a message and come back here',
    'pkgs.logger_on': 'logger active · ',
    'pkgs.logger_off': 'logger inactive · ',

    'mcp.name_ph': 'server name',
    'mcp.target_ph': 'https://… (HTTP) or command: npx -y package',
    'mcp.args_ph': 'extra args (e.g. /home/user)',
    'mcp.add_env': '+ environment variable',
    'mcp.project_scope': 'project (.pi/mcp.json)',
    'mcp.raw_json': 'Raw JSON',
    'mcp.add_server': 'Add server',
    'mcp.remove': 'Remove',

    'prov.title': 'Login — choose a provider',
    'prov.search_ph': 'filter providers…',
    'prov.loading': 'loading providers…',
    'prov.none': 'no providers found',
    'prov.no_cred': 'no credential',
    'prov.current': 'current: {p}',
    'prov.login': 'log in {p}',
    'prov.auth_ok': 'auth ok',

    'theme.restored': "default theme restored (localStorage['theme'] removed)",
    'theme.paste_note': 'paste a JSON of tokens (--bg, --accent, …) and click apply',

    'about.body': 'sightdeck is a desktop client for pi — it never installs or updates pi by itself: the update buttons call pi update.',

    'update.available': 'Update available: {tag}',
    'update.check_fail': 'check failed',
    'update.running': 'running… (may take a while)',

    'git.pull': 'pull',
    'git.discard': 'discard',
    'git.stash': 'stash',
    'git.stash_pop': 'stash pop',
    'git.commit': 'commit',
    'git.commit_push': 'commit & push',
    'git.push': 'push',
    'git.reload': 'refresh',
    'git.commit_msg_ph': 'commit message · Ctrl+Enter commits',
    'git.amend': 'amend',
    'git.force_lease': 'force-with-lease',
    'git.empty_msg': 'empty message — nothing committed',
    'git.commit_push_done': 'commit {h} done, push failed — {e}',
    'git.discard_confirm': 'discard {n} file(s)?\n\n{files}\nand delete {extra} unlisted extra(s)?',
    'git.push_force_confirm': 'git push --force-with-lease\n\nin repository {cwd}?',

    'tools.lines': 'lines',
    'tools.matches': 'matches',
    'tools.entries': 'entries',
    'tools.truncated': '\n… output truncated ({cut} of {total} lines)',
    'tools.thinking': 'thinking',
    'tools.unified': 'unified view',
    'tools.split': 'split view',
    'tools.undo_hunk': 'undo hunk',
    'tools.copy_path': 'copy path',
    'tools.open': 'open',
    'tools.diff_readonly': 'git diff · read-only',
    'tools.reading_diff': 'reading diff…',
    'tools.no_changes': 'no worktree changes',
    'tools.no_diff': 'no diff (new file or untracked content)',
    'tools.diff_fail': 'git diff: {e}',

    'term.in': 'terminal in {cwd} · session in {sess} — use restart',
    'term.dir': 'active terminal directory',
    'term.tab': 'terminal {n}',
    'term.ended': '[ended]',
    'term.close_tab': 'close this tab',
    'term.new': 'New terminal',
    'term.restart': 'restart',
    'term.close': 'Close terminal (Ctrl+`)',
  },
};

export function t(key, vars) {
  const lang = getLang();
  const dict = STRINGS[lang] || {};
  const fb = STRINGS.pt || {};
  const tpl = (key in dict) ? dict[key] : (key in fb ? fb[key] : key);
  return fmt(tpl, vars);
}

/* Aplica o idioma aos estáticos do index.html (por id). Idempotente e tolerante
 * a ids ausentes (testes carregam o HTML parcial). Chamado no boot e ao trocar. */
export function applyStaticI18n() {
  const set = (id, v) => { try { const n = document.getElementById(id); if (n) n.textContent = v; } catch { /* sem DOM */ } };
  const ph = (id, v) => { try { const n = document.getElementById(id); if (n) n.placeholder = v; } catch { /* sem DOM */ } };
  const ti = (id, v) => { try { const n = document.getElementById(id); if (n) n.title = v; } catch { /* sem DOM */ } };
  ph('sesssearch', t('sidebar.search_ph'));
  ph('toolfilter', t('sidebar.tool_filter_ph'));
  ph('input', t('composer.placeholder'));
  ph('cmdkinput', t('composer.cmd_ph'));
  ph('modelsearch', t('composer.model_search_ph'));
  ph('catsearch', t('pkgs.catalog_ph'));
  ph('provsearch', t('prov.search_ph'));
  ph('mcpname', t('mcp.name_ph'));
  ph('mcptarget', t('mcp.target_ph'));
  ph('mcpargs', t('mcp.args_ph'));
  set('confirmok', t('common.execute'));
  set('confirmcancel', t('common.cancel'));
  ti('stopbtn', t('composer.stop'));
  set('lblExpTools', t('settings.expand_tools'));
  set('lblExpThink', t('settings.expand_think'));
  set('lblShowHidden', t('settings.show_hidden'));
  set('lblNotifyDesktop', t('settings.notify_desktop'));
  set('lblNotifySound', t('settings.notify_sound'));
  set('lblHooks', t('settings.instrument'));
  set('lblLang', t('settings.language'));
  set('themebtn', t('settings.theme'));
  set('pkgbtn', t('settings.packages'));
  set('debugbtn', t('settings.debug'));
  set('aboutbtn', t('settings.about'));
  set('checkupdate', t('settings.check_update'));
  set('updExt', t('settings.update_ext'));
  set('updPi', t('settings.update_pi'));
  try {
    const sel = document.getElementById('langsel');
    if (sel && sel.options.length >= 3) {
      sel.options[0].textContent = t('settings.lang_auto');
      sel.options[1].textContent = t('settings.lang_pt');
      sel.options[2].textContent = t('settings.lang_en');
    }
  } catch { /* sem DOM */ }
}
