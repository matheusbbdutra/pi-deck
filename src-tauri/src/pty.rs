use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, State};

/// Teto de bytes lidos por `read`: o base64 de 32 KiB (~43 KiB) cabe folgado
/// na mensagem IPC, e o loop devolve o controle entre chunks.
const READ_CHUNK: usize = 32 * 1024;

/// Shell interativo do usuário. Decisão pura: Unix usa `$SHELL` (cai em `/bin/sh`),
/// Windows usa `%COMSPEC%` (cai em `cmd.exe`) — `$SHELL` não existe lá.
fn choose_shell(shell: Option<String>, comspec: Option<String>, windows: bool) -> String {
    let (candidate, fallback) = if windows {
        (comspec, "cmd.exe")
    } else {
        (shell, "/bin/sh")
    };
    candidate
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

/// Shell do usuário lido do ambiente — o `choose_shell` faz a escolha.
fn user_shell() -> String {
    choose_shell(std::env::var("SHELL").ok(), std::env::var("COMSPEC").ok(), cfg!(windows))
}

/// Payload do evento `pty-data`. Puro para testar o contrato sem GUI.
fn data_payload(id: &str, bytes: &[u8]) -> serde_json::Value {
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    serde_json::json!({ "id": id, "b64": b64 })
}

/// Payload do evento `pty-exit` (EOF ou erro de leitura no master).
fn exit_payload(id: &str) -> serde_json::Value {
    serde_json::json!({ "id": id })
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// Um PTY aberto: master (resize), writer do master e o filho (shell).
pub struct PtyEntry {
    master: Box<dyn MasterPty + Send>,
    /// `Arc<Mutex<_>>` porque `write_all` pode bloquear com o buffer do PTY cheio;
    /// segurar o lock do mapa durante isso travaria `pty_close`/`pty_resize`.
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Box<dyn Child + Send + Sync>,
}

impl PtyEntry {
    /// SIGHUP (com escalada para SIGKILL no `portable-pty`) e `wait` — sem zumbi.
    fn terminate(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Default)]
pub struct PtyState {
    map: Mutex<HashMap<String, PtyEntry>>,
    next_id: AtomicU64,
}

impl PtyState {
    fn next_id(&self) -> String {
        format!("pty-{}", self.next_id.fetch_add(1, Ordering::Relaxed) + 1)
    }

    /// Encerra todos os PTYs (usado ao fechar a janela).
    pub fn kill_all(&self) {
        if let Ok(mut map) = self.map.lock() {
            for (_, mut entry) in map.drain() {
                entry.terminate();
            }
        }
    }
}

/// Abre o PTY e devolve o handle mais o leitor do master — sem Tauri, para testar.
fn spawn(cwd: &str, cols: u16, rows: u16) -> Result<(PtyEntry, Box<dyn Read + Send>), String> {
    if !Path::new(cwd).is_dir() {
        return Err(format!("cwd não é um diretório: {cwd}"));
    }
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(pty_size(cols, rows))
        .map_err(|e| format!("openpty falhou: {e}"))?;
    let portable_pty::PtyPair { master, slave } = pair;

    let shell = user_shell();
    let mut command = CommandBuilder::new(&shell);
    command.cwd(cwd);
    // O shell não pode herdar o TERM do processo que abriu o app: nomes como
    // `otter-term` não existem no terminfo e o zle repinta a linha errado
    // (digitar `ls` aparecia como `lsls`). O xterm.js é xterm-256color.
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    let child = slave
        .spawn_command(command)
        .map_err(|e| format!("falha ao iniciar {shell}: {e}"))?;
    // O lado escravo só pode ficar no filho: no pai ele impediria o EOF.
    drop(slave);

    let reader = master
        .try_clone_reader()
        .map_err(|e| format!("try_clone_reader falhou: {e}"))?;
    let writer = master
        .take_writer()
        .map_err(|e| format!("take_writer falhou: {e}"))?;

    Ok((
        PtyEntry {
            master,
            writer: Arc::new(Mutex::new(writer)),
            child,
        },
        reader,
    ))
}

/// Thread leitora: base64 de cada chunk em `pty-data`, fim em `pty-exit`.
fn read_loop(app: AppHandle, id: String, mut reader: Box<dyn Read + Send>) {
    let mut buf = vec![0u8; READ_CHUNK];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let _ = app.emit("pty-data", data_payload(&id, &buf[..n]));
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    let _ = app.emit("pty-exit", exit_payload(&id));
}

#[tauri::command]
pub fn pty_open(
    app: AppHandle,
    state: State<'_, PtyState>,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    let (entry, reader) = spawn(&cwd, cols, rows)?;
    let id = state.next_id();
    state
        .map
        .lock()
        .map_err(|_| "PtyState envenenado".to_string())?
        .insert(id.clone(), entry);

    let app_out = app.clone();
    let id_out = id.clone();
    thread::spawn(move || read_loop(app_out, id_out, reader));
    Ok(id)
}

/// `b64` = bytes (base64) a escrever no PTY.
#[tauri::command]
pub fn pty_write(state: State<'_, PtyState>, id: String, b64: String) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .map_err(|e| format!("b64 inválido: {e}"))?;
    let writer = {
        let map = state
            .map
            .lock()
            .map_err(|_| "PtyState envenenado".to_string())?;
        map.get(&id)
            .ok_or_else(|| format!("pty desconhecido: {id}"))?
            .writer
            .clone()
    };
    let mut writer = writer
        .lock()
        .map_err(|_| format!("writer de {id} envenenado"))?;
    writer
        .write_all(&bytes)
        .and_then(|_| writer.flush())
        .map_err(|e| format!("escrita no PTY falhou: {e}"))
}

#[tauri::command]
pub fn pty_resize(
    state: State<'_, PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let map = state
        .map
        .lock()
        .map_err(|_| "PtyState envenenado".to_string())?;
    let entry = map.get(&id).ok_or_else(|| format!("pty desconhecido: {id}"))?;
    entry
        .master
        .resize(pty_size(cols, rows))
        .map_err(|e| format!("resize de {id} falhou: {e}"))
}

#[tauri::command]
pub fn pty_close(state: State<'_, PtyState>, id: String) -> Result<(), String> {
    let mut entry = state
        .map
        .lock()
        .map_err(|_| "PtyState envenenado".to_string())?
        .remove(&id)
        .ok_or_else(|| format!("pty desconhecido: {id}"))?;
    entry.terminate();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    #[test]
    fn data_payload_encodes_base64() {
        let got = data_payload("pty-1", b"oi");
        assert_eq!(
            got,
            serde_json::json!({"id": "pty-1", "b64": "b2k="}),
            "payload do pty-data"
        );
    }

    #[test]
    fn exit_payload_only_has_id() {
        assert_eq!(
            exit_payload("pty-7"),
            serde_json::json!({"id": "pty-7"}),
            "payload do pty-exit não tem campo extra"
        );
    }

    // ---------- choose_shell: $SHELL no Unix, %COMSPEC% no Windows ----------

    #[test]
    fn choose_shell_unix_usa_shell_do_ambiente() {
        let s = choose_shell(Some("/usr/bin/zsh".into()), Some("cmd.exe".into()), false);
        assert_eq!(s, "/usr/bin/zsh");
    }

    #[test]
    fn choose_shell_unix_sem_shell_cai_em_bin_sh() {
        assert_eq!(choose_shell(None, Some("cmd.exe".into()), false), "/bin/sh");
        assert_eq!(
            choose_shell(Some(String::new()), None, false),
            "/bin/sh",
            "SHELL vazio conta como ausente"
        );
    }

    #[test]
    fn choose_shell_windows_usa_comspec() {
        let s = choose_shell(
            Some("/bin/bash".into()),
            Some(r"C:\Windows\system32\cmd.exe".into()),
            true,
        );
        assert_eq!(s, r"C:\Windows\system32\cmd.exe");
    }

    #[test]
    fn choose_shell_windows_sem_comspec_cai_em_cmd_exe() {
        assert_eq!(choose_shell(None, None, true), "cmd.exe");
        assert_eq!(
            choose_shell(Some("/bin/bash".into()), Some(String::new()), true),
            "cmd.exe",
            "COMSPEC vazio conta como ausente; $SHELL não vale no Windows"
        );
    }

    #[test]
    fn pty_rejects_missing_cwd() {
        let err = spawn("/nao/existe/mesmo", 80, 24).err().expect("deve falhar");
        assert!(err.contains("cwd"), "erro legível: {err}");
    }

    #[test]
    fn shell_echo_roundtrip() {
        let dir = std::env::temp_dir();
        let (mut entry, mut reader) = spawn(dir.to_str().unwrap(), 80, 24).expect("spawn do PTY");
        entry
            .writer
            .lock()
            .unwrap()
            .write_all(b"echo oi\n")
            .expect("escrita no PTY");

        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let handle = thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        });

        let deadline = Instant::now() + Duration::from_secs(10);
        let mut seen = Vec::new();
        while Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(chunk) => {
                    seen.extend_from_slice(&chunk);
                    if String::from_utf8_lossy(&seen).contains("oi") {
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        entry.terminate();
        let _ = handle.join();

        let text = String::from_utf8_lossy(&seen).to_string();
        assert!(text.contains("oi"), "saída do shell: {text:?}");
    }
}
