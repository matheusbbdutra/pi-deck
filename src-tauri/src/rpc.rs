use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
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
fn take_if_same(
    map: &Arc<Mutex<HashMap<String, ChildHandle>>>,
    session_id: &str,
    pid: u32,
) -> Option<ChildHandle> {
    let mut map = map.lock().ok()?;
    match map.get(session_id) {
        Some(h) if h.pid == pid => map.remove(session_id),
        _ => None,
    }
}

impl RpcState {
    /// Encerra todos os processos `pi` filhos (usado ao fechar a janela).
    pub fn kill_all(&self) {
        if let Ok(mut map) = self.0.lock() {
            for (_, mut handle) in map.drain() {
                let _ = handle.child.kill();
                let _ = handle.child.wait();
            }
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
/// `~/.local/bin` nem os shims do mise — daí `spawn npx ENOENT` nos servidores MCP.
fn child_path() -> Option<std::ffi::OsString> {
    let home = std::path::PathBuf::from(std::env::var_os("HOME")?);
    let mut dirs: Vec<std::ffi::OsString> = [
        ".local/bin",
        ".local/share/mise/shims",
        ".local/share/pi-node/current/bin",
        ".pi/agent/bin",
    ]
    .iter()
    .map(|rel| home.join(rel))
    .filter(|d| d.is_dir())
    .map(|d| d.into_os_string())
    .collect();
    if dirs.is_empty() {
        return None;
    }
    let current = std::env::var_os("PATH").unwrap_or_default();
    dirs.extend(std::env::split_paths(&current).map(|p| p.into_os_string()));
    std::env::join_paths(dirs).ok()
}

/// Uma sessao = um processo `pi --mode rpc` (padrao do pi-desktop).
#[tauri::command]
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
        .env("PI_DECK_CHILD", "1")
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
        if let Some(mut dead) = take_if_same(&reg, &sid_out, child_pid) {
            let _ = dead.child.kill();
            let _ = dead.child.wait();
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
            ChildHandle { child, stdin, pid: child_pid },
        );
    }

    Ok(session_id)
}

#[tauri::command]
pub fn send_prompt(
    state: State<'_, RpcState>,
    session_id: String,
    message: String,
    id: String,
    // Pares (base64, mimeType) — formato ImageContent do RPC do pi.
    images: Option<Vec<(String, String)>>,
) -> Result<(), String> {
    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    let handle = map
        .get_mut(&session_id)
        .ok_or_else(|| format!("sessao '{session_id}' nao iniciada"))?;

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
    let written = handle
        .stdin
        .write_all(command.as_bytes())
        .and_then(|_| handle.stdin.flush());
    if let Err(e) = written {
        // stdin morto = filho já não existe. Libera o slot para o próximo
        // `ensureRpc` subir um processo novo em vez de falhar para sempre.
        map.remove(&session_id);
        return Err(format!("processo do pi encerrou ({e})"));
    }
    Ok(())
}

/// Quantos processos `pi` filhos estão vivos (visibilidade do custo).
#[tauri::command]
pub fn running_sessions(state: State<'_, RpcState>) -> Vec<String> {
    state.running()
}

/// Comando RPC genérico: o frontend manda o JSON pronto (set_model, set_thinking_level, etc.).
#[tauri::command]
pub fn rpc_command(
    state: State<'_, RpcState>,
    session_id: String,
    payload: String,
) -> Result<(), String> {
    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    let handle = map
        .get_mut(&session_id)
        .ok_or_else(|| format!("sessao '{session_id}' nao iniciada"))?;
    let written = handle
        .stdin
        .write_all(format!("{payload}\n").as_bytes())
        .and_then(|_| handle.stdin.flush());
    if let Err(e) = written {
        map.remove(&session_id);
        return Err(format!("processo do pi encerrou ({e})"));
    }
    Ok(())
}

#[tauri::command]
pub fn stop_session(state: State<'_, RpcState>, session_id: String) -> Result<(), String> {
    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut handle) = map.remove(&session_id) {
        let _ = handle.child.kill();
        let _ = handle.child.wait();
    }
    Ok(())
}
