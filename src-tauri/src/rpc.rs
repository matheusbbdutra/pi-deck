use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::fd::AsFd;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use tauri::{AppHandle, Emitter, State};

use crate::sessions::{escape_json, pi_bin};

pub struct ChildHandle {
    child: Child,
    stdin: ChildStdin,
    /// Identidade do processo dono deste slot: o leitor de stdout usa o pid para
    /// não derrubar um filho novo da mesma sessão quando o antigo fecha o pipe.
    pid: u32,
}

/// Slot do mapa de processos: quem é o dono. Existe separado do `ChildHandle`
/// para o teste de `take_if_same` rodar sem processo real.
trait SlotOwner {
    fn owner_pid(&self) -> u32;
}

impl SlotOwner for ChildHandle {
    fn owner_pid(&self) -> u32 {
        self.pid
    }
}

/// Mata e espera um filho que nunca chegou ao mapa (spawn ok, registro falhou).
/// Sem isto o processo cai no Drop ainda vivo e vira órfão (Drop de Child não mata).
fn drop_child(mut child: Child) {
    let _ = child.kill();
    let _ = child.wait();
}

#[derive(Default)]
pub struct RpcState(Arc<Mutex<HashMap<String, ChildHandle>>>);

/// Remove o slot da sessão **se** ainda for deste pid. Devolve o handle para o
/// chamador matar/aguardar fora do lock.
fn take_if_same<T: SlotOwner>(
    map: &Arc<Mutex<HashMap<String, T>>>,
    session_id: &str,
    pid: u32,
) -> Option<T> {
    let mut map = map.lock().ok()?;
    match map.get(session_id) {
        Some(h) if h.owner_pid() == pid => map.remove(session_id),
        _ => None,
    }
}

impl RpcState {
    /// Encerra todos os processos `pi` filhos (usado ao fechar a janela).
    pub fn kill_all(&self) {
        // Drena sob o lock e mata/espara fora dele: `wait()` é bloqueante e sem
        // timeout, e no handler de fechamento da janela isso trava o teardown.
        let drained: Vec<ChildHandle> = match self.0.lock() {
            Ok(mut map) => map.drain().map(|(_, h)| h).collect(),
            Err(_) => return,
        };
        for mut handle in drained {
            let _ = handle.child.kill();
            let _ = handle.child.wait();
        }
    }

    /// Quantos processos estão vivos agora.
    pub fn running(&self) -> Vec<String> {
        self.0
            .lock()
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default()
    }
}

/// PATH do processo filho do `pi`.
/// Aberto pelo lançador gráfico, o app nasce com o PATH do `systemd --user`, que não tem
/// `~/.local/bin` nem os shims do mise — daí `spawn npx ENOENT` nos servidores MCP e
/// `spawn npm ENOENT` em `pi update/install/remove` (o package-manager chama `npm`
/// pelo nome). Fonte única: sessões RPC e update/install/remove usam esta.
pub(crate) fn child_path() -> Option<std::ffi::OsString> {
    let inherited = std::env::var_os("PATH");
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    child_path_with(inherited.as_deref(), home.as_deref(), std::path::Path::is_dir)
}

/// Diretórios de gerenciador de versão/runtime que o PATH do app não tem.
const CHILD_PATH_DIRS: &[&str] = &[
    ".local/bin",
    ".local/share/mise/shims",
    ".local/share/fnm/aliases/default/bin",
    ".volta/bin",
    ".bun/bin",
    ".local/share/pnpm",
    ".local/share/pi-node/current/bin",
    ".pi/agent/bin",
];

/// Decisão pura de `child_path()` — sem env e sem fs, para testar.
/// `None` quando nenhum diretório existe: aí não mexe no PATH herdado.
fn child_path_with(
    inherited: Option<&std::ffi::OsStr>,
    home: Option<&std::path::Path>,
    exists: impl Fn(&std::path::Path) -> bool,
) -> Option<std::ffi::OsString> {
    let home = home?;
    let mut dirs: Vec<std::path::PathBuf> = CHILD_PATH_DIRS
        .iter()
        .map(|rel| home.join(rel))
        .filter(|dir| exists(dir))
        .collect();
    if dirs.is_empty() {
        return None;
    }
    if let Some(path) = inherited {
        dirs.extend(std::env::split_paths(path));
    }
    std::env::join_paths(dirs).ok()
}

/// Uma sessao = um processo `pi --mode rpc` (padrao do pi-desktop).
#[tauri::command(async)]
pub fn start_session(
    app: AppHandle,
    state: State<'_, RpcState>,
    session_id: String,
    cwd: String,
    ref_flag: String,
    ref_value: String,
) -> Result<String, String> {
    {
        let map = state.0.lock().map_err(|e| e.to_string())?;
        if map.contains_key(&session_id) {
            return Ok(session_id);
        }
    }

    let mut cmd = Command::new(pi_bin());
    cmd.args(["--mode", "rpc", ref_flag.as_str(), ref_value.as_str()])
        .env("SIGHTDECK_CHILD", "1")
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Servidores MCP e o bash tool do pi herdam este PATH. Sem os shims do mise
    // (fora do PATH do systemd --user) o `pi mcp` morre com "spawn npx ENOENT".
    if let Some(path) = child_path() {
        cmd.env("PATH", path);
    }
    let mut child = cmd.spawn().map_err(|e| format!("spawn pi: {e}"))?;
    let child_pid = child.id();

    let mut stdin = match child.stdin.take() {
        Some(s) => s,
        // Spawn ok mas sem stdin: sem kill aqui o `child` cai no Drop ainda
        // vivo e vira órfão (Drop de Child não mata o processo).
        None => {
            drop_child(child);
            return Err("sem stdin".to_string());
        }
    };
    // Boot: histórico, estado, modelos e níveis de thinking.
    for cmd in [
        "{\"id\":\"boot-messages\",\"type\":\"get_messages\"}",
        "{\"id\":\"boot-state\",\"type\":\"get_state\"}",
        "{\"id\":\"boot-models\",\"type\":\"get_available_models\"}",
        "{\"id\":\"boot-levels\",\"type\":\"get_available_thinking_levels\"}",
        "{\"id\":\"boot-stats\",\"type\":\"get_session_stats\"}",
        "{\"id\":\"boot-commands\",\"type\":\"get_commands\"}",
    ] {
        let _ = stdin.write_all(format!("{cmd}\n").as_bytes());
    }
    let _ = stdin.flush();
    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            drop_child(child);
            return Err("sem stdout".to_string());
        }
    };
    let stderr = match child.stderr.take() {
        Some(s) => s,
        None => {
            drop_child(child);
            return Err("sem stderr".to_string());
        }
    };

    let sid_out = session_id.clone();
    let app_out = app.clone();
    let reg = state.0.clone();
    let debug = std::env::var("PWUI_DEBUG").is_ok();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if debug {
                let head: String = line.chars().take(150).collect();
                eprintln!("[rpc] {head}");
            }
            let _ = app_out.emit("rpc-line", (sid_out.clone(), line));
        }
        // O filho morreu sozinho (crash/saída): tira o slot do mapa. Sem isto o
        // `start_session` seguinte achava a sessão "já iniciada", devolvia Ok sem
        // subir processo novo e o app ficava sem conseguir mandar nada (stdin morto).
        if let Some(dead) = take_if_same(&reg, &sid_out, child_pid) {
            drop_child(dead.child);
        }
        let _ = app_out.emit("rpc-exit", sid_out);
    });

    let sid_err = session_id.clone();
    let app_err = app.clone();
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if std::env::var("PWUI_DEBUG").is_ok() {
                eprintln!("[rpc stderr] {line}");
            }
            let _ = app_err.emit("rpc-stderr", (sid_err.clone(), line));
        }
    });

    // Re-checa sob lock: outra chamada pode ter registrado a mesma sessão enquanto
    // este processo subia (spawn fora do lock). Sem isto o insert sobrescreve e o
    // ChildHandle descartado vaza o processo (Drop não mata).
    // Lock envenenado também mata o recém-spawnado: sem isto ele órfã do mesmo jeito.
    let mut map = match state.0.lock() {
        Ok(m) => m,
        Err(_) => {
            drop_child(child);
            return Err("lock de sessões envenenado".to_string());
        }
    };
    if map.contains_key(&session_id) {
        drop(map);
        drop_child(child);
    } else {
        map.insert(
            session_id.clone(),
            ChildHandle {
                child,
                stdin,
                pid: child_pid,
            },
        );
    }

    Ok(session_id)
}

#[tauri::command(async)]
pub fn send_prompt(
    state: State<'_, RpcState>,
    session_id: String,
    message: String,
    id: String,
    // Pares (base64, mimeType) — formato ImageContent do RPC do pi.
    images: Option<Vec<(String, String)>>,
) -> Result<(), String> {
    let images_json = match images.as_deref() {
        Some(list) if !list.is_empty() => {
            let items: Vec<String> = list
                .iter()
                .map(|(data, mime)| {
                    format!(
                        "{{\"type\":\"image\",\"data\":\"{}\",\"mimeType\":\"{}\"}}",
                        escape_json(data),
                        escape_json(mime)
                    )
                })
                .collect();
            format!(",\"images\":[{}]", items.join(","))
        }
        _ => String::new(),
    };

    // `streamingBehavior: steer` sempre: o pi só lê o campo quando ainda está streamando
    // (dist/core/agent-session.js:1751 recusa prompt durante o run sem ele) e enfileira;
    // com o agente parado o campo é ignorado e o turno começa normalmente.
    let command = format!(
        "{{\"id\":\"{}\",\"type\":\"prompt\",\"message\":\"{}\",\"streamingBehavior\":\"steer\"{images_json}}}\n",
        escape_json(&id),
        escape_json(&message)
    );
    write_stdin(&state.0, &session_id, command.as_bytes())
}

/// Escreve no stdin da sessão **fora** do lock global: se o filho parar de drenar
/// o stdin, o pipe enche (64 KB) e o write bloqueia — segurando o mutex, isso
/// travaria também `stop_session`, isto é, o próprio cancelamento. O fd é
/// clonado sob o lock e a escrita acontece depois de soltá-lo.
fn write_stdin(
    map: &Arc<Mutex<HashMap<String, ChildHandle>>>,
    session_id: &str,
    bytes: &[u8],
) -> Result<(), String> {
    let fd = {
        let guard = map.lock().map_err(|e| e.to_string())?;
        let handle = guard
            .get(session_id)
            .ok_or_else(|| format!("sessao '{session_id}' nao iniciada"))?;
        handle
            .stdin
            .as_fd()
            .try_clone_to_owned()
            .map_err(|e| format!("clonar stdin falhou: {e}"))?
    };
    let mut pipe = std::fs::File::from(fd);
    match pipe.write_all(bytes).and_then(|_| pipe.flush()) {
        Ok(()) => Ok(()),
        Err(e) => {
            // stdin morto = filho já não existe. Libera o slot para o próximo
            // `ensureRpc` subir um processo novo em vez de falhar para sempre.
            let dead = map.lock().ok().and_then(|mut g| g.remove(session_id));
            if let Some(dead) = dead {
                drop_child(dead.child);
            }
            Err(format!("processo do pi encerrou ({e})"))
        }
    }
}

/// Quantos processos `pi` filhos estão vivos (visibilidade do custo).
#[tauri::command]
pub fn running_sessions(state: State<'_, RpcState>) -> Vec<String> {
    state.running()
}

/// Comando RPC genérico: o frontend manda o JSON pronto (set_model, set_thinking_level, etc.).
#[tauri::command(async)]
pub fn rpc_command(
    state: State<'_, RpcState>,
    session_id: String,
    payload: String,
) -> Result<(), String> {
    // Mesmo motivo do `send_prompt`: sem isto o slot fica envenenado.
    write_stdin(&state.0, &session_id, format!("{payload}\n").as_bytes())
}

#[tauri::command(async)]
pub fn stop_session(state: State<'_, RpcState>, session_id: String) -> Result<(), String> {
    // Remove sob o lock e mata/espara fora: `wait()` bloqueante dentro do mutex
    // global travava todo o canal RPC (inclusive o próprio cancelamento).
    let handle = state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&session_id);
    if let Some(mut handle) = handle {
        let _ = handle.child.kill();
        let _ = handle.child.wait();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Slot de teste: só a identidade do dono, sem processo nenhum.
    struct FakeSlot(u32);

    impl SlotOwner for FakeSlot {
        fn owner_pid(&self) -> u32 {
            self.0
        }
    }

    fn map_with(sid: &str, pid: u32) -> Arc<Mutex<HashMap<String, FakeSlot>>> {
        let mut m = HashMap::new();
        m.insert(sid.to_string(), FakeSlot(pid));
        Arc::new(Mutex::new(m))
    }

    #[test]
    fn take_if_same_remove_slot_quando_pid_bate() {
        let map = map_with("s1", 42);
        let taken = take_if_same(&map, "s1", 42).map(|s| s.0);
        assert_eq!(taken, Some(42));
        assert!(map.lock().unwrap().is_empty());
    }

    #[test]
    fn take_if_same_preserva_slot_quando_pid_difere() {
        // Corrida real: o filho antigo fecha o stdout depois de um novo já ter
        // registrado a mesma sessão. O slot do novo não pode ser removido.
        let map = map_with("s1", 7);
        assert!(take_if_same(&map, "s1", 8).is_none());
        let guard = map.lock().unwrap();
        assert_eq!(guard.get("s1").map(|s| s.0), Some(7));
    }

    #[test]
    fn take_if_same_sem_chave_nao_entra_em_panico() {
        let map: Arc<Mutex<HashMap<String, FakeSlot>>> = Arc::new(Mutex::new(HashMap::new()));
        assert!(take_if_same(&map, "s1", 1).is_none());
    }

    // ---------- child_path: PATH do filho com node/npm ----------

    #[test]
    fn child_path_pone_node_na_frente_do_path_herdado() {
        // Separador de PATH é `;` no Windows e `:` no resto: monta e compara pelos
        // componentes, senão o teste passa aqui e quebra no CI do Windows.
        let Ok(inherited) = std::env::join_paths(["/usr/bin", "/bin"]) else {
            panic!("join_paths falhou");
        };
        let got = child_path_with(
            Some(inherited.as_os_str()),
            Some(std::path::Path::new("/home/u")),
            |p| p.ends_with("mise/shims"),
        );
        let Some(got) = got else {
            panic!("com dir existente deve devolver PATH");
        };
        let dirs: Vec<std::path::PathBuf> = std::env::split_paths(&got).collect();
        assert_eq!(dirs.len(), 3, "{got:?}");
        assert!(dirs[0].ends_with("mise/shims"), "{:?}", dirs[0]);
        assert_eq!(dirs[1], std::path::PathBuf::from("/usr/bin"));
        assert_eq!(dirs[2], std::path::PathBuf::from("/bin"));
    }

    #[test]
    fn child_path_none_sem_dir_existente_nao_mexe_no_path() {
        assert_eq!(
            child_path_with(
                Some(std::ffi::OsStr::new("/usr/bin")),
                Some(std::path::Path::new("/home/u")),
                |_| false
            ),
            None
        );
        assert_eq!(
            child_path_with(Some(std::ffi::OsStr::new("/usr/bin")), None, |_| true),
            None
        );
    }
}
