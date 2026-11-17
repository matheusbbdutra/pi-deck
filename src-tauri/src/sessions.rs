use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

/// Home do usuário: `HOME` e, no Windows (sem `HOME`), `USERPROFILE`.
/// Decisão pura — valores vazios contam como ausentes, para testar sem `set_var` (global).
fn pick_home(home: Option<OsString>, userprofile: Option<OsString>) -> Option<PathBuf> {
    fn non_empty(v: Option<OsString>) -> Option<PathBuf> {
        v.filter(|s| !s.is_empty()).map(PathBuf::from)
    }
    non_empty(home).or_else(|| non_empty(userprofile))
}

/// Sufixo do executável do SO: `.exe` no Windows, nada nos demais.
fn bin_suffix(windows: bool) -> &'static str {
    if windows {
        ".exe"
    } else {
        ""
    }
}

/// Caminho do binário `pi`.
/// Aberto pelo lançador gráfico o app não herda o PATH do shell (os error 2),
/// então procura nos diretórios de instalação antes de cair no PATH.
pub fn pi_bin() -> PathBuf {
    // `SIGHTDECK_PI_BIN` é o nome atual; `PI_DECK_PI_BIN` continua aceito para
    // não quebrar quem já tinha script apontando para o binário.
    let env_val = std::env::var("SIGHTDECK_PI_BIN")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| {
            std::env::var("PI_DECK_PI_BIN")
                .ok()
                .filter(|v| !v.trim().is_empty())
        });
    let home = pick_home(std::env::var_os("HOME"), std::env::var_os("USERPROFILE"));
    resolve_pi_bin(env_val.as_deref(), home.as_deref(), Path::is_file)
}

/// Decisão pura de `pi_bin()` — sem env e sem fs, para testar sem `set_var` (global).
fn resolve_pi_bin(
    env_val: Option<&str>,
    home: Option<&Path>,
    exists: impl Fn(&Path) -> bool,
) -> PathBuf {
    resolve_pi_bin_with(env_val, home, bin_suffix(cfg!(windows)), exists)
}

/// Mesma decisão com o sufixo de executável explícito — testável para os dois SOs.
fn resolve_pi_bin_with(
    env_val: Option<&str>,
    home: Option<&Path>,
    suffix: &str,
    exists: impl Fn(&Path) -> bool,
) -> PathBuf {
    if let Some(p) = env_val.map(str::trim).filter(|p| !p.is_empty()) {
        return PathBuf::from(p);
    }
    if let Some(home) = home {
        for rel in [
            format!(".pi/agent/bin/pi{suffix}"),
            format!(".local/bin/pi{suffix}"),
            format!(".local/share/fnm/aliases/default/bin/pi{suffix}"),
        ] {
            let cand = home.join(rel);
            if exists(&cand) {
                return cand;
            }
        }
    }
    PathBuf::from(format!("pi{suffix}"))
}

/// `Command` do CLI `pi` com o PATH ampliado (fonte única em `rpc::child_path`):
/// `pi update/install/remove` chamam `npm` pelo nome e o app aberto pelo
/// launcher gráfico não herda o PATH do shell — sem isso, `spawn npm ENOENT`.
fn pi_cmd() -> std::process::Command {
    let mut cmd = std::process::Command::new(pi_bin());
    if let Some(path) = crate::rpc::child_path() {
        cmd.env("PATH", path);
    }
    cmd
}

/// Root onde o pi guarda as sessões (`~/.pi/agent/sessions`).
fn sessions_root() -> Result<PathBuf, String> {
    let home = pick_home(std::env::var_os("HOME"), std::env::var_os("USERPROFILE"))
        .ok_or("HOME nem USERPROFILE definidos")?;
    Ok(home.join(".pi/agent/sessions"))
}

/// Resolve `path` e exige que esteja sob `root`.
/// `canonicalize` resolve `..` e symlinks antes de comparar, então `../` não escapa.
fn contained_in(path: &Path, root: &Path) -> Result<PathBuf, String> {
    let canon_root = root
        .canonicalize()
        .map_err(|e| format!("diretório base indisponível ({}): {e}", root.display()))?;
    let canon = path
        .canonicalize()
        .map_err(|e| format!("{}: {e}", path.display()))?;
    if !canon.starts_with(&canon_root) {
        return Err(format!(
            "caminho fora do diretório permitido: {}",
            path.display()
        ));
    }
    Ok(canon)
}

/// Extensão gerada pelo app: registra hooks e escreve uma linha por invocação.
const HOOK_EXTENSION: &str = r#"// sightdeck hook logger — gerado pelo sightdeck. Desligue em Ajustes → Instrumentar hooks.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const dir = join(homedir(), ".pi", "agent", "sightdeck");
const file = join(dir, "hooks.log");

function log(hook, extra) {
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(file, new Date().toISOString() + " " + hook + (extra ? " " + extra : "") + "\n");
  } catch { /* silencioso */ }
}

const HOOKS = [
  "session_start",
  "agent_start",
  "before_agent_start",
  "tool_call",
  "message_end",
  "agent_end",
  "agent_settled",
  "model_select",
];

export default function (pi) {
  for (const name of HOOKS) {
    pi.on(name, async (event) => {
      let extra = "";
      try {
        if (name === "tool_call" && event && event.toolName) extra = String(event.toolName);
        if (name === "model_select" && event && event.model) extra = String(event.model.id || event.model);
      } catch { /* ignora */ }
      log(name, extra);
    });
  }
}
"#;

/// Lista de providers conhecidos pelo pi (com flag `configured`).
/// O CLI só expõe essa lista no erro de `pi auth login <invalido>`, então é de lá que vem.
#[tauri::command]
pub fn auth_providers() -> Result<String, String> {
    let mut providers: Vec<String> = Vec::new();

    if let Ok(out) = std::process::Command::new(pi_bin())
        .args(["auth", "login", "__deck_list__", "--no-browser"])
        .output()
    {
        let err = String::from_utf8_lossy(&out.stderr);
        for line in err.lines() {
            if let Some(rest) = line.strip_prefix("Providers: ") {
                providers = rest
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
            }
        }
    }

    // Fallback: os providers que já têm modelos configurados.
    if providers.is_empty() {
        if let Ok(out) = std::process::Command::new(pi_bin()).arg("--list-models").output() {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines().skip(1) {
                if let Some(p) = line.split_whitespace().next() {
                    if !providers.iter().any(|x| x == p) {
                        providers.push(p.to_string());
                    }
                }
            }
        }
    }

    // providers com modelo no catálogo
    let mut configured: Vec<String> = Vec::new();
    if let Ok(out) = std::process::Command::new(pi_bin()).arg("--list-models").output() {
        let text = String::from_utf8_lossy(&out.stdout);
        for line in text.lines().skip(1) {
            if let Some(p) = line.split_whitespace().next() {
                if !configured.iter().any(|x| x == p) {
                    configured.push(p.to_string());
                }
            }
        }
    }

    let items: Vec<String> = providers
        .iter()
        .map(|p| {
            let configured = configured.iter().any(|c| c == p);
            // Só consulta credencial dos que têm modelo no catálogo (evita 44 chamadas).
            let status = if configured {
                std::process::Command::new(pi_bin())
                    .args(["auth", "check", "--provider", p, "--json"])
                    .output()
                    .ok()
                    .map(|o| {
                        let out = String::from_utf8_lossy(&o.stdout);
                        let parsed = out.trim();
                        if parsed.contains("\"ready\"") {
                            "ready".to_string()
                        } else if parsed.contains("not_ready") {
                            "not_ready".to_string()
                        } else {
                            "unknown".to_string()
                        }
                    })
                    .unwrap_or_else(|| "unknown".to_string())
            } else {
                String::new()
            };

            format!(
                "{{\"name\":\"{}\",\"configured\":{},\"status\":\"{}\"}}",
                escape_json(p),
                configured,
                status
            )
        })
        .collect();

    Ok(format!("[{}]", items.join(",")))
}

/// Status de auth do provider: `pi auth check --provider X --json`.
#[tauri::command]
pub fn auth_status(provider: String) -> Result<String, String> {
    let p = provider.trim();
    if p.is_empty() {
        return Err("provider vazio".to_string());
    }
    let out = std::process::Command::new(pi_bin())
        .args(["auth", "check", "--provider", p, "--json"])
        .output()
        .map_err(|e| format!("spawn pi auth: {e}"))?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Providers aceitos em `open_terminal_login`, verificados contra o `pi` instalado
/// (`pi auth login __deck_list__ --no-browser`, mesma origem de `auth_providers`).
/// Como o nome é interpolado em `sh -c`, só vale nome exato desta lista:
/// nada fora dela chega ao shell.
const LOGIN_PROVIDERS: &[&str] = &[
    "amazon-bedrock", "ant-ling", "anthropic", "azure", "baseten", "cerebras",
    "cloudflare-ai-gateway", "cloudflare-workers-ai", "deepseek", "fireworks",
    "github-copilot", "google", "google-vertex", "groq", "huggingface",
    "kimi-coding", "meta", "minimax", "minimax-cn", "mistral", "moonshotai",
    "moonshotai-cn", "nvidia", "openai", "openai-codex", "opencode", "opencode-go",
    "openrouter", "qwen-token-plan", "qwen-token-plan-cn",
    "qwen-token-plan-individual", "qwen-token-plan-individual-cn", "radius",
    "together", "typesafe", "vercel-ai-gateway", "xai", "xiaomi",
    "xiaomi-token-plan-ams", "xiaomi-token-plan-cn", "xiaomi-token-plan-sgp",
    "zai", "zai-coding-cn",
];

/// Valida `provider` contra a allowlist (rejeita vazio, fora-da-lista e
/// qualquer coisa fora de `[a-z0-9-]` — cinturão extra caso a lista cresça).
fn validate_login_provider(provider: &str) -> Result<&str, String> {
    let p = provider.trim();
    if p.is_empty() {
        return Err("informe o provider".to_string());
    }
    if !LOGIN_PROVIDERS.contains(&p) {
        return Err(format!("provider desconhecido: \"{p}\""));
    }
    if !p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return Err(format!("provider inválido: \"{p}\""));
    }
    Ok(p)
}

/// Cita o caminho do binário para o shell do alvo. Shell POSIX aceita single quote
/// com o escape `'\''`; `cmd.exe` do Windows não interpreta single quote — lá é double quote.
fn quote_bin(path: &str) -> String {
    if cfg!(windows) {
        format!("\"{}\"", path.replace('"', ""))
    } else {
        format!("'{}'", path.replace('\'', r"'\''"))
    }
}

/// Comando que o terminal do alvo roda: `pi auth login` e uma pausa para o usuário
/// ler o resultado antes da janela fechar. POSIX usa `sh`; no Windows o terminal é
/// `powershell.exe`, então a pausa é `Read-Host` (o `read -r _` do bash não existe lá).
fn login_inner(bin_quoted: &str, provider: &str, windows: bool) -> String {
    if windows {
        format!("{bin_quoted} auth login {provider}; Write-Host ''; Read-Host 'enter para fechar'")
    } else {
        format!(
            "{bin_quoted} auth login {provider}; echo; printf 'enter para fechar '; read -r _"
        )
    }
}

/// Abre um terminal já rodando `pi auth login <provider>` (login é interativo).
#[tauri::command]
pub fn open_terminal_login(provider: String) -> Result<String, String> {
    let p = validate_login_provider(&provider)?;
    let bin = quote_bin(&pi_bin().to_string_lossy());
    let inner = login_inner(&bin, p, cfg!(windows));

    #[cfg(target_os = "linux")]
    let candidates: Vec<(&str, Vec<String>)> = vec![
        ("xdg-terminal-exec", vec!["sh".into(), "-c".into(), inner.clone()]),
        ("kitty", vec!["sh".into(), "-c".into(), inner.clone()]),
        ("alacritty", vec!["-e".into(), "sh".into(), "-c".into(), inner.clone()]),
        ("foot", vec!["sh".into(), "-c".into(), inner.clone()]),
        ("wezterm", vec!["start".into(), "--".into(), "sh".into(), "-c".into(), inner.clone()]),
        ("xterm", vec!["-e".into(), "sh".into(), "-c".into(), inner.clone()]),
    ];
    #[cfg(target_os = "macos")]
    let candidates: Vec<(&str, Vec<String>)> = vec![(
        "open",
        vec!["-a".into(), "Terminal".into(), inner.clone()],
    )];
    #[cfg(target_os = "windows")]
    let candidates: Vec<(&str, Vec<String>)> = vec![(
        "powershell.exe",
        vec![
            "-NoExit".into(),
            "-Command".into(),
            inner.clone(),
        ],
    )];

    for (prog, args) in candidates {
        if let Ok(mut child) = std::process::Command::new(prog).args(&args).spawn() {
            // "spawn ok" não significa terminal aberto: se ele morrer logo, tenta o próximo.
            std::thread::sleep(std::time::Duration::from_millis(300));
            match child.try_wait() {
                Ok(Some(status)) if !status.success() => continue,
                _ => return Ok(format!("terminal aberto ({prog}) — conclua o login de {p}")),
            }
        }
    }

    Err(format!("nenhum terminal respondeu; copie e rode: pi auth login {p}"))
}

/// Copia texto para a área de transferência usando utilitário do sistema.
#[tauri::command]
pub fn copy_text(text: String) -> Result<(), String> {
    use std::io::Write;
    use std::process::{Command, Stdio};

    #[cfg(target_os = "linux")]
    let candidates: Vec<(&str, Vec<&str>)> = vec![
        ("wl-copy", vec![]),
        ("xclip", vec!["-selection", "clipboard"]),
        ("xsel", vec!["--clipboard", "--input"]),
    ];
    #[cfg(target_os = "macos")]
    let candidates: Vec<(&str, Vec<&str>)> = vec![("pbcopy", vec![])];
    #[cfg(target_os = "windows")]
    let candidates: Vec<(&str, Vec<&str>)> = vec![("clip", vec![])];

    for (prog, args) in candidates {
        let Ok(mut child) = Command::new(prog)
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        else {
            continue;
        };
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(text.as_bytes());
        }
        if child.wait().map(|s| s.success()).unwrap_or(false) {
            return Ok(());
        }
    }
    Err("nenhum utilitário de clipboard disponível".to_string())
}


/// Abre o seletor de pasta do sistema e devolve o caminho escolhido.
/// Seletor de arquivo para anexar como contexto (o caminho vai no texto do prompt).
/// Async de propósito: o `zenity` bloqueia até o diálogo fechar e comando síncrono
/// prende a thread principal do Tauri — o GNOME declara "Not Responding".
#[tauri::command]
pub async fn pick_file() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(pick_file_blocking)
        .await
        .map_err(|e| format!("seletor de arquivo falhou: {e}"))?
}

fn pick_file_blocking() -> Result<String, String> {
    #[cfg(target_os = "linux")]
    let out = std::process::Command::new("zenity")
        .args(["--file-selection", "--title=Anexar arquivo como contexto"])
        .output();

    #[cfg(target_os = "macos")]
    let out = std::process::Command::new("osascript")
        .args(["-e", "POSIX path of (choose file)"])
        .output();

    #[cfg(target_os = "windows")]
    let out = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "Add-Type -AssemblyName System.Windows.Forms; $f=New-Object System.Windows.Forms.OpenFileDialog; if($f.ShowDialog() -eq 'OK'){$f.FileName}",
        ])
        .output();

    let out = out.map_err(|e| format!("seletor de arquivo indisponível: {e}"))?;
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();

    if path.is_empty() {
        return Err("cancelado".to_string());
    }
    if !std::path::PathBuf::from(&path).is_file() {
        return Err(format!("não é um arquivo: {path}"));
    }
    Ok(path)
}

/// Lê imagem da área de transferência do sistema e devolve `(base64, mimeType)`.
/// A WebKitGTK não entrega `image/*` no evento `paste` do webview, então o app
/// consulta o clipboard do sistema direto. Só lê: nunca escreve no clipboard.
#[tauri::command]
pub fn paste_image() -> Result<(String, String), String> {
    use base64::Engine;

    #[cfg(target_os = "linux")]
    let raw = read_clipboard_image_linux();

    #[cfg(target_os = "macos")]
    let raw = std::process::Command::new("pngpaste")
        .arg("-")
        .output()
        .map(|o| o.stdout)
        .unwrap_or_default();

    #[cfg(target_os = "windows")]
    let raw = {
        let tmp = std::env::temp_dir().join("sightdeck-paste.png");
        let script = format!(
            "Add-Type -AssemblyName System.Windows.Forms; $i=[Windows.Forms.Clipboard]::GetImage(); if($i){{$i.Save('{}')}}",
            tmp.display()
        );
        let _ = std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", &script])
            .output();
        let bytes = std::fs::read(&tmp).unwrap_or_default();
        let _ = std::fs::remove_file(&tmp);
        bytes
    };

    const MAX_BYTES: usize = 16 * 1024 * 1024;
    if raw.is_empty() {
        return Err("clipboard sem imagem".to_string());
    }
    if raw.len() > MAX_BYTES {
        return Err(format!(
            "imagem grande demais: {} MB",
            raw.len() / 1024 / 1024
        ));
    }

    // Confere o magic: nunca devolve binário arbitrário do clipboard ao webview.
    let mime = if raw.starts_with(&[0x89, b'P', b'N', b'G']) {
        "image/png"
    } else if raw.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg"
    } else if raw.starts_with(b"GIF8") {
        "image/gif"
    } else if raw.len() > 12 && &raw[0..4] == b"RIFF" && &raw[8..12] == b"WEBP" {
        "image/webp"
    } else {
        return Err("clipboard não tem imagem suportada".to_string());
    };

    Ok((
        base64::engine::general_purpose::STANDARD.encode(&raw),
        mime.to_string(),
    ))
}

/// Bytes de imagem do clipboard no Linux (Wayland com queda para X11).
/// `--list-types` responde em ~2 ms; `--type image/png` num clipboard de texto segura
/// ~1 s antes de falhar (medido 2026-11-15) e isto roda a cada Ctrl+V — era o que
/// travava o campo de texto a cada colagem.
#[cfg(target_os = "linux")]
fn read_clipboard_image_linux() -> Vec<u8> {
    let list = std::process::Command::new("wl-paste")
        .arg("--list-types")
        .output();
    // `wl-paste` instalado mas sem display Wayland sai com status != 0: aí o X11 vale.
    let wayland_ok = matches!(&list, Ok(o) if o.status.success());
    let mime = list.ok().and_then(|o| {
        String::from_utf8_lossy(&o.stdout)
            .lines()
            .map(str::trim)
            .find(|l| l.starts_with("image/"))
            .map(str::to_string)
    });

    if let Some(mime) = mime {
        let out = std::process::Command::new("wl-paste")
            .args(["--type", &mime, "--no-newline"])
            .output();
        if let Ok(o) = out {
            if !o.stdout.is_empty() {
                return o.stdout;
            }
        }
    }
    if wayland_ok {
        // Wayland respondeu: o clipboard é texto (ou imagem ilegível) — nada de X11.
        return Vec::new();
    }
    std::process::Command::new("xclip")
        .args(["-selection", "clipboard", "-t", "image/png", "-o"])
        .output()
        .map(|o| o.stdout)
        .unwrap_or_default()
}

/// Async pelo mesmo motivo do `pick_file`: `zenity --file-selection --directory`
/// fica aberto (muitas vezes atrás de outra janela) e o `.output()` síncrono
/// congelaria o app até o usuário achar e fechar o diálogo.
#[tauri::command]
pub async fn pick_directory() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(pick_directory_blocking)
        .await
        .map_err(|e| format!("seletor de pasta falhou: {e}"))?
}

fn pick_directory_blocking() -> Result<String, String> {
    #[cfg(target_os = "linux")]
    let out = std::process::Command::new("zenity")
        .args([
            "--file-selection",
            "--directory",
            "--title=Escolher pasta do projeto",
        ])
        .output();

    #[cfg(target_os = "macos")]
    let out = std::process::Command::new("osascript")
        .args(["-e", "POSIX path of (choose folder)"])
        .output();

    #[cfg(target_os = "windows")]
    let out = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "Add-Type -AssemblyName System.Windows.Forms; $f=New-Object System.Windows.Forms.FolderBrowserDialog; if($f.ShowDialog() -eq 'OK'){$f.SelectedPath}",
        ])
        .output();

    let out = out.map_err(|e| format!("seletor de pasta indisponível: {e}"))?;
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();

    if path.is_empty() {
        return Err("cancelado".to_string());
    }
    if !std::path::PathBuf::from(&path).is_dir() {
        return Err(format!("não é uma pasta: {path}"));
    }
    Ok(path)
}

/// Versão deste app (compilada do Cargo.toml).
#[tauri::command]
pub fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Caminhos e SO para o "Sobre": sem isso a UI só teria as versões e o usuário
/// não descobre qual binário do `pi` nem onde estão as sessões.
#[tauri::command]
pub fn app_info() -> String {
    let agent = pick_home(std::env::var_os("HOME"), std::env::var_os("USERPROFILE"))
        .map(|h| h.join(".pi/agent"));
    serde_json::json!({
        "piBin": pi_bin().display().to_string(),
        "agent": agent
            .as_ref()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| "?".to_string()),
        "sessions": sessions_root()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|e| format!("? ({e})")),
        "os": std::env::consts::OS,
    })
    .to_string()
}

/// Abre uma URL no navegador padrão do sistema.
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("somente http(s)".to_string());
    }

    #[cfg(target_os = "linux")]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(&url);
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg(&url);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", "", &url]);
        c
    };

    cmd.spawn().map_err(|e| format!("abrir navegador: {e}"))?;
    Ok(())
}

/// Abre um arquivo do projeto no app padrão do SO (editor/visor).
/// `cwd` é o projeto da sessão: o alvo precisa estar contido nele.
#[tauri::command]
pub fn open_file(cwd: String, path: String) -> Result<(), String> {
    let target = open_file_in(Path::new(&cwd), Path::new(&path))?;

    #[cfg(target_os = "linux")]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(&target);
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg(&target);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let arg = target.to_string_lossy().into_owned();
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", "", &arg]);
        c
    };

    cmd.spawn().map_err(|e| format!("abrir arquivo: {e}"))?;
    Ok(())
}

/// Valida o alvo sem abrir: contido no projeto e arquivo real.
fn open_file_in(cwd: &Path, path: &Path) -> Result<PathBuf, String> {
    let target = contained_in(path, cwd)?;
    if !target.is_file() {
        return Err(format!("não é arquivo: {}", target.display()));
    }
    Ok(target)
}

/// Desfaz UM hunk do patch exibido na aba Arquivos (`session_edits`).
/// `cwd` é o projeto da sessão (mesmo precedente de `open_file`): o alvo precisa
/// estar contido nele. `hunk` é o trecho `@@ ... @@` com suas linhas `-`/`+`.
/// O arquivo real é lido só para comparar (nunca vai ao webview): exige que o
/// bloco adicionado (`+`) apareça exatamente 1 vez e o troca pelo bloco removido
/// (`-`). Recusa hunk só de adições (ex.: `write`, só `+`), hunk só de remoções
/// (reinserção sem âncora) e patch truncado, com erro legível.
#[tauri::command]
pub fn revert_hunk(cwd: String, file: String, hunk: String) -> Result<String, String> {
    revert_hunk_in(Path::new(&cwd), Path::new(&file), &hunk)
}

/// Mesma lógica com cwd/root explícito — testável sem Tauri.
fn revert_hunk_in(cwd: &Path, file: &Path, hunk: &str) -> Result<String, String> {
    if hunk.len() > MAX_PATCH_BYTES {
        return Err(format!(
            "hunk grande demais ({} bytes, teto {}): recarregue a aba Arquivos",
            hunk.len(),
            MAX_PATCH_BYTES
        ));
    }
    if hunk.contains("\u{2026} patch truncado") {
        return Err("patch truncado: recarregue a aba Arquivos para ver o diff completo"
            .to_string());
    }
    let mut removed: Vec<&str> = Vec::new();
    let mut added: Vec<&str> = Vec::new();
    for line in hunk.lines() {
        if line.starts_with("---")
            || line.starts_with("+++")
            || line.starts_with("@@")
            || line.starts_with("diff ")
            || line.starts_with("index ")
            || line.starts_with('\\')
        {
            continue;
        } else if let Some(rest) = line.strip_prefix('-') {
            removed.push(rest);
        } else if let Some(rest) = line.strip_prefix('+') {
            added.push(rest);
        }
    }
    if removed.is_empty() {
        return Err(
            "revers\u{00e3}o recusada: hunk s\u{00f3} com adi\u{00e7}\u{00f5}es (write/adi\u{00e7}\u{00e3}o pura) \u{2014} nada para restaurar".to_string(),
        );
    }
    if added.is_empty() {
        return Err(
            "revers\u{00e3}o recusada: hunk s\u{00f3} com remo\u{00e7}\u{00f5}es \u{2014} posi\u{00e7}\u{00e3}o de reinser\u{00e7}\u{00e3}o amb\u{00ed}gua".to_string(),
        );
    }
    // Sem isso, um path vindo do webview reescreve qualquer arquivo legível.
    let target = contained_in(file, cwd)?;
    if !target.is_file() {
        return Err(format!("não é arquivo: {}", target.display()));
    }
    // Só para comparar: o conteúdo nunca volta ao webview (só status/contagem).
    let current = fs::read_to_string(&target)
        .map_err(|e| format!("ler {}: {e}", target.display()))?;
    let trailing_nl = current.ends_with('\n');
    let lines: Vec<&str> = current.lines().collect();
    let mut hits: Vec<usize> = Vec::new();
    if added.len() <= lines.len() {
        for i in 0..=lines.len() - added.len() {
            if lines[i..i + added.len()] == added[..] {
                hits.push(i);
            }
        }
    }
    match hits.len() {
        0 => {
            return Err("o arquivo mudou desde o patch: bloco adicionado não encontrado (nada foi alterado)".to_string());
        }
        n if n > 1 => {
            return Err(format!(
                "bloco aparece {n} vezes no arquivo atual: reversão ambígua recusada (nada foi alterado)"
            ));
        }
        _ => {}
    }
    let at = hits[0];
    let mut next: Vec<&str> = Vec::with_capacity(lines.len() - added.len() + removed.len());
    next.extend_from_slice(&lines[..at]);
    next.extend_from_slice(&removed);
    next.extend_from_slice(&lines[at + added.len()..]);
    let mut out = next.join("\n");
    if trailing_nl {
        out.push('\n');
    }
    if out.len() > MAX_EDIT_BYTES {
        return Err(format!(
            "resultado grande demais ({} bytes, teto {}): reversão recusada",
            out.len(),
            MAX_EDIT_BYTES
        ));
    }
    fs::write(&target, out).map_err(|e| format!("escrever {}: {e}", target.display()))?;
    Ok(format!("hunk desfeito em {}", target.display()))
}


pub(crate) fn escape_json(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// Eco de diagnóstico do frontend (só com PWUI_DEBUG=1).
#[tauri::command]
pub fn debug_note(msg: String) -> String {
    if std::env::var("PWUI_DEBUG").is_ok() {
        eprintln!("[ui] {msg}");
    }
    msg
}

/// Pacotes instalados (`pi list`), texto cru.
#[tauri::command]
pub fn pi_list() -> Result<String, String> {
    let out = std::process::Command::new(pi_bin())
        .arg("list")
        .output()
        .map_err(|e| format!("spawn pi: {e}"))?;
    let mut text = String::from_utf8_lossy(&out.stdout).to_string();
    if text.trim().is_empty() {
        text = String::from_utf8_lossy(&out.stderr).to_string();
    }
    Ok(text)
}

/// Instala um pacote pelo CLI oficial (`pi install <source>`).
#[tauri::command]
pub fn pi_install(spec: String, local: bool) -> Result<String, String> {
    let mut cmd = pi_cmd();
    cmd.args(["install", spec.as_str(), "--no-approve"]);
    if local {
        cmd.arg("-l");
    }
    let out = cmd.output().map_err(|e| format!("spawn pi: {e}"))?;
    let mut text = String::from_utf8_lossy(&out.stdout).to_string();
    let err = String::from_utf8_lossy(&out.stderr);
    if !err.trim().is_empty() {
        text.push('\n');
        text.push_str(&err);
    }
    Ok(format!("exit {}\n{}", out.status.code().unwrap_or(-1), text.trim()))
}

/// Adiciona/atualiza servidor MCP via `pi mcp add` (o CLI grava o mcp.json).
#[tauri::command]
pub fn pi_mcp_add(
    name: String,
    url: String,
    argv: Vec<String>,
    env: Vec<String>,
    headers: Vec<String>,
    local: bool,
) -> Result<String, String> {
    let mut cmd = std::process::Command::new(pi_bin());
    cmd.args(["mcp", "add", name.as_str()]);
    if local {
        cmd.arg("-l");
    }
    for e in &env {
        if !e.trim().is_empty() {
            cmd.args(["--env", e]);
        }
    }
    for h in &headers {
        if !h.trim().is_empty() {
            cmd.args(["--header", h]);
        }
    }
    if !url.trim().is_empty() {
        cmd.args(["--url", url.trim()]);
    } else {
        if argv.is_empty() {
            return Err("informe uma URL ou um comando".to_string());
        }
        cmd.arg("--");
        cmd.args(&argv);
    }

    let out = cmd.output().map_err(|e| format!("spawn pi: {e}"))?;
    let mut text = String::from_utf8_lossy(&out.stdout).to_string();
    let err = String::from_utf8_lossy(&out.stderr);
    if !err.trim().is_empty() {
        text.push('\n');
        text.push_str(&err);
    }
    Ok(format!("exit {}\n{}", out.status.code().unwrap_or(-1), text.trim()))
}

/// Remove um pacote instalado (`pi remove <source>`).
#[tauri::command]
pub fn pi_remove(spec: String, local: bool) -> Result<String, String> {
    let mut cmd = pi_cmd();
    cmd.args(["remove", spec.as_str(), "--no-approve"]);
    if local {
        cmd.arg("-l");
    }
    let out = cmd.output().map_err(|e| format!("spawn pi: {e}"))?;
    let mut text = String::from_utf8_lossy(&out.stdout).to_string();
    let err = String::from_utf8_lossy(&out.stderr);
    if !err.trim().is_empty() {
        text.push('\n');
        text.push_str(&err);
    }
    Ok(format!("exit {}\n{}", out.status.code().unwrap_or(-1), text.trim()))
}

/// Remove servidor MCP (`pi mcp remove <name>`).
#[tauri::command]
pub fn pi_mcp_remove(name: String, local: bool) -> Result<String, String> {
    let mut cmd = std::process::Command::new(pi_bin());
    cmd.args(["mcp", "remove", name.as_str()]);
    if local {
        cmd.arg("-l");
    }
    let out = cmd.output().map_err(|e| format!("spawn pi: {e}"))?;
    let mut text = String::from_utf8_lossy(&out.stdout).to_string();
    let err = String::from_utf8_lossy(&out.stderr);
    if !err.trim().is_empty() {
        text.push('\n');
        text.push_str(&err);
    }
    Ok(format!("exit {}\n{}", out.status.code().unwrap_or(-1), text.trim()))
}

/// Servidores MCP em JSON (`pi mcp list --json`) — evita ler mcp.json e expor `env`.
#[tauri::command]
pub fn pi_mcp_list() -> Result<String, String> {
    let out = std::process::Command::new(pi_bin())
        .args(["mcp", "list", "--json"])
        .output()
        .map_err(|e| format!("spawn pi: {e}"))?;
    let mut text = String::from_utf8_lossy(&out.stdout).to_string();
    if text.trim().is_empty() {
        text = String::from_utf8_lossy(&out.stderr).to_string();
    }
    Ok(text)
}

/// Atualiza pi e/ou extensões pelo próprio CLI (`pi update`).
#[tauri::command]
pub fn pi_update(scope: String) -> Result<String, String> {
    let target = match scope.as_str() {
        "self" => "--self",
        "all" => "--all",
        "models" => "--models",
        _ => "--extensions",
    };

    let out = pi_cmd()
        .args(["update", target, "--no-approve"])
        .output()
        .map_err(|e| format!("spawn pi: {e}"))?;

    let mut text = String::from_utf8_lossy(&out.stdout).to_string();
    let err = String::from_utf8_lossy(&out.stderr);
    if !err.trim().is_empty() {
        text.push('\n');
        text.push_str(&err);
    }
    let code = out.status.code().unwrap_or(-1);
    Ok(format!("exit {code}\n{}", text.trim()))
}

/// `pi` filhos marcados com SIGHTDECK_CHILD cujo pai morreu (ppid 1) — limpa órfãos de crash.
#[tauri::command]
pub fn kill_orphans() -> Result<usize, String> {
    let entries = fs::read_dir("/proc").map_err(|e| e.to_string())?;
    let mut killed = 0usize;

    for entry in entries.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let base = format!("/proc/{pid}");

        let Ok(environ) = fs::read(format!("{base}/environ")) else {
            continue;
        };
        if !String::from_utf8_lossy(&environ).contains("SIGHTDECK_CHILD=1") {
            continue;
        }

        let Ok(stat) = fs::read_to_string(format!("{base}/stat")) else {
            continue;
        };
        let ppid = stat
            .split_whitespace()
            .nth(3)
            .and_then(|s| s.parse::<u32>().ok())
            .unwrap_or(0);
        if ppid != 1 {
            continue;
        }

        let _ = std::process::Command::new("kill").arg(pid.to_string()).status();
        killed += 1;
    }

    Ok(killed)
}

/// Converte "204.8K"/"1M" da tabela do CLI em bytes.
fn parse_context(raw: &str) -> u64 {
    let t = raw.trim().to_uppercase();
    let (num, mult) = if let Some(v) = t.strip_suffix('K') {
        (v, 1_000u64)
    } else if let Some(v) = t.strip_suffix('M') {
        (v, 1_000_000u64)
    } else {
        (t.as_str(), 1u64)
    };
    num.replace(',', ".")
        .parse::<f64>()
        .map(|f| (f * mult as f64) as u64)
        .unwrap_or(0)
}

/// Catálogo de modelos direto do CLI (`pi --list-models`) — instantâneo, sem subir sessão.
#[tauri::command]
pub fn pi_models() -> Result<String, String> {
    let out = std::process::Command::new(pi_bin())
        .arg("--list-models")
        .output()
        .map_err(|e| format!("spawn pi: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);

    let mut items: Vec<String> = Vec::new();
    for line in text.lines().skip(1) {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 3 || cols[0].starts_with("provider") {
            continue;
        }
        items.push(format!(
            "{{\"provider\":\"{}\",\"id\":\"{}\",\"name\":\"{}\",\"contextWindow\":{}}}",
            escape_json(cols[0]),
            escape_json(cols[1]),
            escape_json(cols[1]),
            parse_context(cols[2])
        ));
    }

    Ok(format!("[{}]", items.join(",")))
}

/// Último modelo registrado na sessão (record `model_change`), sem precisar de RPC.
#[tauri::command]
pub fn session_model(path: String) -> Result<String, String> {
    let raw = fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))?;

    let mut provider = String::new();
    let mut model_id = String::new();

    for line in raw.lines() {
        if !line.contains("\"type\":\"model_change\"") {
            continue;
        }
        if let Some(p) = extract_string(line, "\"provider\":\"") {
            provider = p;
        }
        if let Some(m) = extract_string(line, "\"modelId\":\"") {
            model_id = m;
        }
    }

    if model_id.is_empty() {
        return Ok("null".to_string());
    }
    Ok(format!(
        "{{\"provider\":\"{}\",\"id\":\"{}\"}}",
        escape_json(&provider),
        escape_json(&model_id)
    ))
}

/// Caminho do log de hooks e se a extensão de instrumentação está instalada.
#[tauri::command]
pub fn hooks_status() -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let ext = std::path::PathBuf::from(format!("{home}/.pi/agent/extensions/sightdeck-hooks.js"));
    let log = std::path::PathBuf::from(format!("{home}/.pi/agent/sightdeck/hooks.log"));
    Ok(format!(
        "{{\"installed\":{},\"extension\":\"{}\",\"log\":\"{}\"}}",
        ext.is_file(),
        ext.display(),
        log.display()
    ))
}

/// Instala a extensão que registra hooks em `~/.pi/agent/sightdeck/hooks.log`.
#[tauri::command]
pub fn hooks_install() -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let dir = std::path::PathBuf::from(format!("{home}/.pi/agent/extensions"));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ext = dir.join("sightdeck-hooks.js");
    fs::write(&ext, HOOK_EXTENSION).map_err(|e| format!("escrever {}: {e}", ext.display()))?;
    Ok(format!("instalado em {}", ext.display()))
}

#[tauri::command]
pub fn hooks_remove() -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let ext = std::path::PathBuf::from(format!("{home}/.pi/agent/extensions/sightdeck-hooks.js"));
    if ext.is_file() {
        fs::remove_file(&ext).map_err(|e| e.to_string())?;
        return Ok("removido".to_string());
    }
    Ok("não estava instalado".to_string())
}

/// Últimas linhas do log de hooks.
#[tauri::command]
pub fn hooks_tail(lines: Option<usize>) -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let path = format!("{home}/.pi/agent/sightdeck/hooks.log");
    let Ok(raw) = fs::read_to_string(&path) else {
        return Ok(String::new());
    };
    let max = lines.unwrap_or(200).clamp(1, 2000);
    let all: Vec<&str> = raw.lines().collect();
    let start = all.len().saturating_sub(max);
    Ok(all[start..].join("\n"))
}

/* ---------- compactação: limite de contexto escolhido pelo usuário ---------- */

/// `settings.json` do projeto — o pi o lê na criação da sessão (vale após reiniciar).
fn project_settings_path(cwd: &str) -> PathBuf {
    Path::new(cwd).join(".pi").join("settings.json")
}

/// Carrega o settings.json do projeto; arquivo ausente ou vazio vira `{}`.
fn load_project_settings(path: &Path) -> Result<serde_json::Value, String> {
    if !path.is_file() {
        return Ok(serde_json::json!({}));
    }
    let raw = fs::read_to_string(path).map_err(|e| format!("ler {}: {e}", path.display()))?;
    if raw.trim().is_empty() {
        return Ok(serde_json::json!({}));
    }
    serde_json::from_str(&raw).map_err(|e| format!("{} inválido: {e}", path.display()))
}

/// Compactação efetiva de `provider/model` no arquivo (null = sem override, usa o padrão do pi).
fn compaction_state(root: &serde_json::Value, key: &str) -> String {
    let ov = root
        .get("compaction")
        .and_then(|c| c.get("modelOverrides"))
        .and_then(|m| m.get(key));
    serde_json::json!({
        "reserveTokens": ov.and_then(|v| v.get("reserveTokens")).and_then(|v| v.as_u64()),
        "keepRecentTokens": ov.and_then(|v| v.get("keepRecentTokens")).and_then(|v| v.as_u64()),
    })
    .to_string()
}

/// Grava (ou remove, com `None`) `compaction.modelOverrides[key].reserveTokens`.
/// Preserva o resto do arquivo e poda os objetos que ficarem vazios.
fn set_model_reserve(
    root: &mut serde_json::Value,
    key: &str,
    value: Option<u64>,
) -> Result<(), String> {
    let obj = root
        .as_object_mut()
        .ok_or("settings.json do projeto não é um objeto")?;
    let compaction = obj
        .entry("compaction")
        .or_insert_with(|| serde_json::json!({}));
    let c = compaction
        .as_object_mut()
        .ok_or("compaction em settings.json não é um objeto")?;
    let overrides = c
        .entry("modelOverrides")
        .or_insert_with(|| serde_json::json!({}));
    let m = overrides
        .as_object_mut()
        .ok_or("compaction.modelOverrides não é um objeto")?;

    match value {
        Some(n) => {
            let entry = m
                .entry(key.to_string())
                .or_insert_with(|| serde_json::json!({}));
            let e = entry
                .as_object_mut()
                .ok_or_else(|| format!("modelOverrides[{key}] não é um objeto"))?;
            e.insert("reserveTokens".to_string(), serde_json::json!(n));
        }
        None => {
            let emptied = m.get_mut(key).and_then(|v| v.as_object_mut()).map(|e| {
                e.remove("reserveTokens");
                e.is_empty()
            });
            if emptied == Some(true) {
                m.remove(key);
            }
        }
    }

    let no_overrides = m.is_empty();
    if no_overrides {
        c.remove("modelOverrides");
    }
    let no_compaction = c.is_empty();
    if no_compaction {
        obj.remove("compaction");
    }
    Ok(())
}

/// Compactação configurada para o modelo no projeto (padrão do pi quando ausente).
#[tauri::command]
pub fn compaction_get(cwd: String, provider: String, model: String) -> Result<String, String> {
    let root = load_project_settings(&project_settings_path(&cwd))?;
    Ok(compaction_state(&root, &format!("{provider}/{model}")))
}

/// Define (ou remove, com `reserve_tokens: null`) a reserva de contexto do modelo no projeto.
#[tauri::command]
pub fn compaction_set(
    cwd: String,
    provider: String,
    model: String,
    reserve_tokens: Option<u64>,
) -> Result<String, String> {
    let path = project_settings_path(&cwd);
    let mut root = load_project_settings(&path)?;
    let key = format!("{provider}/{model}");
    set_model_reserve(&mut root, &key, reserve_tokens)?;
    // Sem nada a gravar e sem arquivo existente: não cria `.pi/` por nada.
    if !path.is_file() && root.as_object().is_some_and(|o| o.is_empty()) {
        return Ok(compaction_state(&root, &key));
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("criar {}: {e}", dir.display()))?;
    }
    let mut body = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    body.push('\n');
    fs::write(&path, body).map_err(|e| format!("escrever {}: {e}", path.display()))?;
    Ok(compaction_state(&root, &key))
}

/// Versão do `pi` instalado.
#[tauri::command]
pub fn pi_version() -> String {
    std::process::Command::new(pi_bin())
        .arg("--version")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "?".to_string())
}

/// Flags de debug para testes automatizados (env vars).
#[tauri::command]
pub fn debug_flags() -> String {
    let mut flags: Vec<&str> = Vec::new();
    if std::env::var("PWUI_AUTONEW").is_ok() {
        flags.push("autonew");
    }
    if std::env::var("PWUI_DEBUG").is_ok() {
        flags.push("debug");
    }
    flags.join(",")
}

/// Sessão "sem pasta": cwd = HOME (grupo `--home-<user>--`).
#[tauri::command]
pub fn home_dir() -> Result<String, String> {
    std::env::var("HOME").map_err(|e| e.to_string())
}

/// Lê o valor string de uma chave, respeitando escapes (`\"`, `\n`, `\\`).
fn extract_string(line: &str, key: &str) -> Option<String> {
    let start = line.find(key)? + key.len();
    let bytes: Vec<char> = line[start..].chars().collect();

    let mut raw = String::new();
    let mut backslashes = 0usize;
    for ch in bytes {
        if ch == '"' && backslashes.is_multiple_of(2) {
            break;
        }
        if ch == '\\' {
            backslashes += 1;
        } else {
            backslashes = 0;
        }
        raw.push(ch);
    }
    if raw.is_empty() {
        return None;
    }

    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push(' '),
            Some('"') => out.push('"'),
            Some('\\') => out.push('\\'),
            Some(other) => out.push(other),
            None => {}
        }
    }
    Some(out)
}

/// Título = `session_info.name` (setado por `/name`, `--name`) ou a 1ª mensagem do usuário.
fn read_title(session_file: &Path) -> Option<String> {
    let file = fs::File::open(session_file).ok()?;
    let mut name: Option<String> = None;
    let mut first_user: Option<String> = None;

    for (idx, line) in BufReader::new(file).lines().enumerate() {
        if idx > 200 {
            break;
        }
        let Ok(line) = line else { break };

        if line.contains("\"type\":\"session_info\"") {
            if let Some(n) = extract_string(&line, "\"name\":\"") {
                name = Some(n); // o último vence
            }
        }
        if first_user.is_none() && line.contains("\"role\":\"user\"") {
            // User message: content e' array [{"type":"text","text":"..."}].
            first_user = extract_string(&line, "\"text\":\"")
                .or_else(|| extract_string(&line, "\"content\":\""));
        }
        if name.is_some() && first_user.is_some() {
            break;
        }
    }

    let picked = name.or(first_user)?;
    // tira cercas de código e colapsa espacos
    let flat = picked
        .replace('`', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if flat.is_empty() {
        return None;
    }
    Some(flat.chars().take(64).collect())
}

fn read_cwd(session_file: &Path) -> Option<String> {
    let file = fs::File::open(session_file).ok()?;
    let mut first = String::new();
    BufReader::new(file).read_line(&mut first).ok()?;
    extract_string(&first, "\"cwd\":\"")
}

fn read_mtime(session_file: &Path) -> u64 {
    fs::metadata(session_file)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Estado do child a partir do arquivo de sessão dele.
/// `stopReason: stop` = terminou; `toolUse` = parou no meio (interrompido).
/// Sem `stopReason` = desconhecido.
fn child_state(session_file: &Path) -> &'static str {
    use std::io::{Read, Seek, SeekFrom};

    let Ok(mut f) = fs::File::open(session_file) else {
        return "unknown";
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(64 * 1024);
    if f.seek(SeekFrom::Start(start)).is_err() {
        return "unknown";
    }
    let mut buf = Vec::new();
    if f.read_to_end(&mut buf).is_err() {
        return "unknown";
    }
    let tail = String::from_utf8_lossy(&buf);

    let Some(idx) = tail.rfind("\"role\":\"assistant\"") else {
        return "unknown";
    };

    match extract_string(&tail[idx..], "\"stopReason\":\"").as_deref() {
        Some("stop") => "done",
        Some("toolUse") => "unfinished",
        Some(_) => "unknown",
        None => "unknown",
    }
}

/// Últimas `limit` mensagens de um arquivo de sessão (JSONL), precedidas por um record
/// `__deck_meta` com quantas ficaram de fora. Evita mandar 20 MB+ para o webview.
#[tauri::command]
pub fn read_session_messages(
    path: String,
    limit: Option<usize>,
    skip: Option<usize>,
) -> Result<String, String> {
    let root = sessions_root()?;
    read_session_messages_in(Path::new(&path), &root, limit, skip)
}

/// Mesma lógica, com o root explícito — testável sem tocar em `HOME`.
fn read_session_messages_in(
    path: &Path,
    root: &Path,
    limit: Option<usize>,
    skip: Option<usize>,
) -> Result<String, String> {
    // Sem isso, um path vindo do webview lê qualquer arquivo legível.
    let path = contained_in(path, root)?;
    let max = limit.unwrap_or(250).clamp(1, 2000);
    let skip = skip.unwrap_or(0);
    let raw = fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;

    // Orçamento em bytes: 250 mensagens podem somar dezenas de MB (toolResults grandes).
    const MAX_LINE_BYTES: usize = 64 * 1024;
    const MAX_TOTAL_BYTES: usize = 1024 * 1024;

    // Passo 1: contar TODAS as mensagens. Sem isto, o `total` parava no `break`
    // da coleta e `hasMore` saía sempre falso (bug do botão "carregar anteriores").
    let total = raw.lines().filter(|l| l.contains("\"type\":\"message\"")).count();

    let mut kept: Vec<&str> = Vec::new();
    let mut skipped = 0usize;
    let mut oversized = 0usize;
    let mut budget = MAX_TOTAL_BYTES;

    // Passo 2: pegar de trás para frente, pulando o que já está na tela.
    for line in raw.lines().rev() {
        if !line.contains("\"type\":\"message\"") {
            continue;
        }

        if skipped < skip {
            skipped += 1;
            continue;
        }
        if line.len() > MAX_LINE_BYTES {
            oversized += 1;
            continue;
        }
        if line.len() > budget {
            break;
        }
        budget -= line.len();
        kept.push(line);
        if kept.len() >= max {
            break;
        }
    }
    kept.reverse();

    let older = total.saturating_sub(skipped + kept.len() + oversized);
    let consumed = skipped + kept.len() + oversized;
    let mut out = format!(
        "{{\"type\":\"__deck_meta\",\"omitted\":{older},\"oversized\":{oversized},\"total\":{total},\"consumed\":{consumed},\"hasMore\":{},\"bytes\":{}}}\n",
        older > 0,
        MAX_TOTAL_BYTES - budget
    );
    for line in kept {
        out.push_str(line);
        out.push('\n');
    }
    Ok(out)
}

/// "Exclui" uma sessão movendo o `.jsonl` e o diretório de children para
/// `<projeto>/.sightdeck-trash/<stem>/`. Nunca apaga de verdade.
#[tauri::command]
pub fn delete_session(file: String) -> Result<String, String> {
    let root = sessions_root()?;
    delete_session_in(Path::new(&file), &root)
}

/// Mesma lógica, com o root explícito — testável sem tocar em `HOME`.
fn delete_session_in(file: &Path, root: &Path) -> Result<String, String> {
    if !file.is_file() {
        return Err(format!("sessão não encontrada: {}", file.display()));
    }
    // Sem isso, um path vindo do webview move qualquer arquivo para .sightdeck-trash.
    let src = contained_in(file, root)?;

    let stem = src
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or("arquivo sem nome")?;
    let dir = src.parent().ok_or("sem diretório")?.to_path_buf();
    let trash = dir.join(".sightdeck-trash").join(&stem);
    fs::create_dir_all(&trash).map_err(|e| format!("criar lixeira: {e}"))?;

    let file_name = src.file_name().ok_or("arquivo sem nome")?.to_owned();
    fs::rename(&src, trash.join(&file_name)).map_err(|e| format!("mover sessão: {e}"))?;

    let children = dir.join(&stem);
    if children.is_dir() {
        fs::rename(&children, trash.join(&stem)).map_err(|e| format!("mover children: {e}"))?;
    }

    Ok(format!("movido para {}", trash.display()))
}

/// Children da sessão lidos do disco: `<sessão>/<childId>/run-N/session.jsonl`.
/// Usado quando não há widget ao vivo (sessão aberta do histórico).
#[tauri::command]
pub fn list_children(dir: String) -> Result<String, String> {
    list_children_in(&std::path::PathBuf::from(&dir), &sessions_root()?)
}

fn list_children_in(dir: &Path, root: &Path) -> Result<String, String> {
    // Sessão sem children: o diretório irmão do `.jsonl` nunca existiu e o
    // `canonicalize` de contained_in falharia com NotFound (os error 2).
    // Checar antes: diretório inexistente não enumera nada e não vaza path.
    if !dir.is_dir() {
        return Ok("[]".to_string());
    }
    // Sem isso, um dir vindo do webview enumera qualquer diretório legível.
    let dir = contained_in(dir, root)?;

    let mut items: Vec<(u64, String)> = Vec::new();

    let Ok(children) = fs::read_dir(&dir) else {
        return Ok("[]".to_string());
    };

    for child in children.flatten() {
        let child_dir = child.path();
        if !child_dir.is_dir() {
            continue;
        }
        let child_id = child
            .file_name()
            .to_string_lossy()
            .to_string();

        let Ok(runs) = fs::read_dir(&child_dir) else {
            continue;
        };

        for run in runs.flatten() {
            let run_dir = run.path();
            let run_name = run.file_name().to_string_lossy().to_string();
            if !run_dir.is_dir() || !run_name.starts_with("run-") {
                continue;
            }
            let file = run_dir.join("session.jsonl");
            if !file.is_file() {
                continue;
            }
            let label = read_title(&file).unwrap_or_default();
            let label = label.trim_start_matches("Task:").trim().to_string();
            let short: String = label.chars().take(60).collect();

            let mtime = read_mtime(&file);
            let mut state = child_state(&file);
            // Heurística: arquivo tocado nos últimos 2 min e sem `stop` -> provavelmente rodando.
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            if state != "done" && now.saturating_sub(mtime) < 120_000 {
                state = "running";
            }
            let json = format!(
                "{{\"id\":\"{}\",\"run\":\"{}\",\"label\":\"{}\",\"state\":\"{}\",\"file\":\"{}\",\"mtime\":{}}}",
                escape_json(&child_id),
                escape_json(&run_name),
                escape_json(&short),
                state,
                escape_json(&file.to_string_lossy()),
                mtime
            );
            items.push((mtime, json));
        }
    }

    items.sort_by_key(|a| std::cmp::Reverse(a.0));
    let body = items
        .into_iter()
        .map(|(_, json)| json)
        .collect::<Vec<_>>()
        .join(",");
    Ok(format!("[{body}]"))
}

/// Edições de arquivo da sessão **e dos seus children**, com o patch de cada uma.
/// `path` = `.jsonl` da sessão; children vêm de `<stem>/<childId>/run-N/session.jsonl`.
/// O patch é o `details.patch` que a própria tool `edit` já grava no histórico.
#[tauri::command]
pub fn session_edits(path: String) -> Result<String, String> {
    let root = sessions_root()?;
    session_edits_in(Path::new(&path), &root)
}

/// Teto por patch, por total e de entradas: um `write` de arquivo grande não pode
/// entupir o IPC do webview (a UI também trunca por linha ao desenhar).
const MAX_PATCH_BYTES: usize = 64 * 1024;
const MAX_EDIT_BYTES: usize = 4 * 1024 * 1024;
const MAX_EDIT_ENTRIES: usize = 500;

/// Mesma lógica com o root explícito — testável sem tocar em `HOME`.
fn session_edits_in(path: &Path, root: &Path) -> Result<String, String> {
    // Mesma checagem de contenção: path vem do webview.
    let main = contained_in(path, root)?;
    let mut items: Vec<serde_json::Value> = Vec::new();
    collect_edits(&main, "sessão", &mut items);

    let children = main.with_extension("");
    if children.is_dir() {
        for child in fs::read_dir(&children).into_iter().flatten().flatten() {
            let child_dir = child.path();
            if !child_dir.is_dir() {
                continue;
            }
            let id = child.file_name().to_string_lossy().to_string();
            let short: String = id.chars().take(8).collect();
            for run in fs::read_dir(&child_dir).into_iter().flatten().flatten() {
                let run_dir = run.path();
                let run_name = run.file_name().to_string_lossy().to_string();
                if !run_dir.is_dir() || !run_name.starts_with("run-") {
                    continue;
                }
                let file = run_dir.join("session.jsonl");
                if file.is_file() {
                    collect_edits(&file, &format!("{short}/{run_name}"), &mut items);
                }
            }
        }
    }

    // Mais recente primeiro: o que acabou de ser editado fica no topo.
    items.sort_by(|a, b| {
        let at = |v: &serde_json::Value| v["at"].as_i64().unwrap_or(0);
        at(b).cmp(&at(a))
    });

    // Orçamento aplicado do mais novo para o mais antigo: o que acabou de ser editado
    // é o que importa. (Aplicar durante a leitura descartaria justamente o fim do
    // arquivo, que é a edição mais recente.)
    let mut kept: Vec<serde_json::Value> = Vec::new();
    let mut bytes = 0usize;
    for item in items {
        let len = item["patch"].as_str().map(str::len).unwrap_or(0);
        if kept.len() >= MAX_EDIT_ENTRIES || bytes + len > MAX_EDIT_BYTES {
            break;
        }
        bytes += len;
        kept.push(item);
    }
    Ok(serde_json::Value::Array(kept).to_string())
}

/// Andando o JSONL: junta o `toolCall` (path/ferramenta) com o `toolResult` (patch).
fn collect_edits(file: &Path, src: &str, out: &mut Vec<serde_json::Value>) {
    let Ok(handle) = fs::File::open(file) else {
        return;
    };
    // toolCallId -> (ferramenta, path, patch sintético do `write`)
    let mut pending: std::collections::HashMap<String, (String, String, String)> =
        std::collections::HashMap::new();

    for line in BufReader::new(handle).lines().map_while(Result::ok) {
        if !line.contains("\"type\":\"message\"") {
            continue;
        }
        let Ok(rec) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let msg = &rec["message"];
        match msg["role"].as_str().unwrap_or("") {
            "assistant" => {
                for block in msg["content"].as_array().into_iter().flatten() {
                    if block["type"].as_str() != Some("toolCall") {
                        continue;
                    }
                    let name = block["name"].as_str().unwrap_or("");
                    if name != "edit" && name != "write" {
                        continue;
                    }
                    let path = block["arguments"]["path"].as_str().unwrap_or("");
                    // `write` não deixa patch no resultado: monta um diff só de adições.
                    let synth = if name == "write" {
                        block["arguments"]["content"]
                            .as_str()
                            .map(added_patch)
                            .unwrap_or_default()
                    } else {
                        String::new()
                    };
                    pending.insert(
                        block["id"].as_str().unwrap_or("").to_string(),
                        (name.to_string(), path.to_string(), synth),
                    );
                }
            }
            "toolResult" => {
                let name = msg["toolName"].as_str().unwrap_or("");
                if name != "edit" && name != "write" {
                    continue;
                }
                let Some((tool, file, synth)) =
                    pending.remove(msg["toolCallId"].as_str().unwrap_or(""))
                else {
                    continue;
                };
                // Edição que falhou/rejeitada não conta como arquivo editado.
                if msg["isError"].as_bool() == Some(true) {
                    continue;
                }
                let mut patch = msg["details"]["patch"]
                    .as_str()
                    .filter(|p| !p.is_empty())
                    .map(str::to_string)
                    .or_else(|| msg["details"]["diff"].as_str().map(str::to_string))
                    .unwrap_or(synth);
                // `truncate` exige fronteira de char: patch tem UTF-8.
                if patch.len() > MAX_PATCH_BYTES {
                    let cut = (0..=MAX_PATCH_BYTES)
                        .rev()
                        .find(|i| patch.is_char_boundary(*i))
                        .unwrap_or(0);
                    patch.truncate(cut);
                    patch.push_str("\n… patch truncado");
                }
                out.push(serde_json::json!({
                    "file": file,
                    "tool": tool,
                    "at": msg["timestamp"].as_i64().unwrap_or(0),
                    "src": src,
                    "patch": patch,
                }));
            }
            _ => {}
        }
    }
}

/// Conteúdo de um `write` como diff de adições (limitado a 400 linhas).
fn added_patch(content: &str) -> String {
    let mut out = String::new();
    for (i, line) in content.lines().enumerate() {
        if i >= 400 {
            out.push_str("…\n");
            break;
        }
        out.push('+');
        out.push_str(line);
        out.push('\n');
    }
    out
}

/// Sidebar: sessões agrupadas por pasta.
/// `file` = caminho absoluto do `.jsonl` (é o que vai em `pi --session <path>`).
#[tauri::command]
pub fn list_sessions() -> Result<String, String> {
    let root = sessions_root()?;
    let entries = fs::read_dir(&root).map_err(|e| format!("{}: {e}", root.display()))?;

    let mut groups: Vec<(String, Vec<String>)> = Vec::new();

    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let Ok(inner) = fs::read_dir(&dir) else {
            continue;
        };

        let mut sessions: Vec<(u64, String, String)> = Vec::new(); // (mtime, json, cwd)

        for file in inner.flatten() {
            let path = file.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(stem) = path.file_stem().map(|s| s.to_string_lossy().to_string()) else {
                continue;
            };

            let cwd = read_cwd(&path).unwrap_or_default();
            let title = read_title(&path).unwrap_or_default();
            let child_dir = path.with_extension("");
            let children = if child_dir.is_dir() {
                fs::read_dir(&child_dir)
                    .map(|d| d.flatten().count())
                    .unwrap_or(0)
            } else {
                0
            };

            let json = format!(
                "{{\"id\":\"{}\",\"file\":\"{}\",\"cwd\":\"{}\",\"title\":\"{}\",\"children\":{}}}",
                escape_json(&stem),
                escape_json(&path.to_string_lossy()),
                escape_json(&cwd),
                escape_json(&title),
                children
            );
            sessions.push((read_mtime(&path), json, cwd));
        }

        // Grupo sem sessão não aparece (era o que virava "--home-user--" na sidebar).
        if sessions.is_empty() {
            continue;
        }

        sessions.sort_by_key(|a| std::cmp::Reverse(a.0));

        let group_path = sessions
            .iter()
            .map(|s| s.2.clone())
            .find(|c| !c.is_empty())
            .unwrap_or_else(|| {
                dir.file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default()
            });

        groups.push((group_path, sessions.into_iter().map(|s| s.1).collect()));
    }

    groups.sort_by(|a, b| a.0.cmp(&b.0));

    let json = groups
        .iter()
        .map(|(path, items)| {
            let name = path.rsplit('/').next().unwrap_or(path);
            let name = if name.is_empty() { path.as_str() } else { name };
            format!(
                "{{\"path\":\"{}\",\"name\":\"{}\",\"sessions\":[{}]}}",
                escape_json(path),
                escape_json(name),
                items.join(",")
            )
        })
        .collect::<Vec<_>>()
        .join(",");

    Ok(format!("[{json}]"))
}

/// Busca global no texto das sessões (`<root>/<proj>/<sess>.jsonl`).
/// `query` casa por substring (case-insensitive) no texto + nomes de tool;
/// `tool` restringe a mensagens que usam a tool; `errors_only` a `toolResult` com erro.
/// Pagina com `limit` (1..=100, padrão 20) + `offset`, e para o scan ao estourar o
/// teto de bytes (`MAX_EDIT_BYTES`, o mesmo das edições): árvore gigante não pode
/// entupir o IPC do webview. Linha gigante (> `MAX_PATCH_BYTES`) é pulada.
/// Retorna `{"total","truncated","results":[{"id","file","cwd","title","matches","snippet","tools","hasError"}]}`.
#[tauri::command]
pub fn search_sessions(
    query: String,
    tool: Option<String>,
    errors_only: Option<bool>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<String, String> {
    let root = sessions_root()?;
    search_sessions_in(
        &root,
        &query,
        tool.as_deref(),
        errors_only.unwrap_or(false),
        limit,
        offset,
    )
}

/// Mesma lógica com o root explícito — testável sem tocar em `HOME`.
/// Linha de resultado da busca: (mtime, id, file, cwd, title, matches, snippet, tools, has_error).
type SearchHit = (u64, String, String, String, String, usize, String, Vec<String>, bool);

fn search_sessions_in(
    root: &Path,
    query: &str,
    tool: Option<&str>,
    errors_only: bool,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<String, String> {
    let q = query.trim().to_lowercase();
    let toolf = tool
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(|t| t.to_lowercase());
    if q.is_empty() && toolf.is_none() && !errors_only {
        return Ok("{\"total\":0,\"truncated\":false,\"results\":[]}".to_string());
    }
    let toolf = toolf.as_deref();

    // Mesma árvore que `list_sessions`: `<root>/<proj>/<sess>.jsonl`, recentes primeiro.
    let mut files: Vec<(u64, PathBuf)> = Vec::new();
    let entries = fs::read_dir(root).map_err(|e| format!("{}: {e}", root.display()))?;
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let Ok(inner) = fs::read_dir(&dir) else {
            continue;
        };
        for file in inner.flatten() {
            let path = file.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            // Mesma validação das outras leituras: path precisa estar sob o root.
            let Ok(path) = contained_in(&path, root) else {
                continue;
            };
            files.push((read_mtime(&path), path));
        }
    }
    files.sort_by_key(|a| std::cmp::Reverse(a.0));

    let mut scanned: usize = 0;
    let mut truncated = false;
    let mut hits: Vec<SearchHit> = Vec::new();

    'files: for (mtime, file) in &files {
        let Ok(handle) = fs::File::open(file) else {
            continue;
        };
        let mut matches = 0usize;
        let mut snippet = String::new();
        let mut tools: Vec<String> = Vec::new();
        let mut has_error = false;
        for line in BufReader::new(handle).lines().map_while(Result::ok) {
            if !line.contains("\"type\":\"message\"") {
                continue;
            }
            if line.len() > MAX_PATCH_BYTES {
                continue;
            }
            scanned += line.len();
            if scanned > MAX_EDIT_BYTES {
                truncated = true;
                break 'files;
            }
            let Ok(rec) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            let msg = &rec["message"];
            let mut text = String::new();
            let mut msg_tools: Vec<String> = Vec::new();
            let mut msg_error = false;
            match msg["role"].as_str().unwrap_or("") {
                "user" => {
                    if let Some(s) = msg["content"].as_str() {
                        text.push_str(s);
                    } else {
                        for b in msg["content"].as_array().into_iter().flatten() {
                            if b["type"].as_str() == Some("text") {
                                if let Some(s) = b["text"].as_str() {
                                    text.push_str(s);
                                    text.push('\n');
                                }
                            }
                        }
                    }
                }
                "assistant" => {
                    for b in msg["content"].as_array().into_iter().flatten() {
                        match b["type"].as_str() {
                            Some("text") => {
                                if let Some(s) = b["text"].as_str() {
                                    text.push_str(s);
                                    text.push('\n');
                                }
                            }
                            Some("toolCall") => {
                                let name = b["name"].as_str().unwrap_or("");
                                if !name.is_empty() {
                                    msg_tools.push(name.to_string());
                                    text.push_str(name);
                                    text.push('\n');
                                    text.push_str(&b["arguments"].to_string());
                                    text.push('\n');
                                }
                            }
                            _ => {}
                        }
                    }
                }
                "toolResult" => {
                    let name = msg["toolName"].as_str().unwrap_or("");
                    if !name.is_empty() {
                        msg_tools.push(name.to_string());
                        text.push_str(name);
                        text.push('\n');
                    }
                    if msg["isError"].as_bool() == Some(true) {
                        msg_error = true;
                        has_error = true;
                    }
                    if let Some(s) = msg["content"].as_str() {
                        text.push_str(s);
                    } else {
                        for b in msg["content"].as_array().into_iter().flatten() {
                            if let Some(s) = b["text"].as_str() {
                                text.push_str(s);
                                text.push('\n');
                            }
                        }
                    }
                }
                _ => continue,
            }
            for t in &msg_tools {
                if tools.len() < 12 && !tools.iter().any(|x| x == t) {
                    tools.push(t.clone());
                }
            }
            if errors_only && !msg_error {
                continue;
            }
            if let Some(want) = toolf {
                if !msg_tools.iter().any(|t| t.to_lowercase() == want) {
                    continue;
                }
            }
            if !q.is_empty() && !text.to_lowercase().contains(&q) {
                continue;
            }
            matches += 1;
            if snippet.is_empty() {
                let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
                snippet = flat.chars().take(240).collect();
            }
        }
        if matches == 0 {
            continue;
        }
        let stem = file
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        hits.push((
            *mtime,
            stem,
            file.to_string_lossy().to_string(),
            read_cwd(file).unwrap_or_default(),
            read_title(file).unwrap_or_default(),
            matches,
            snippet,
            tools,
            has_error,
        ));
    }

    let total = hits.len();
    let off = offset.unwrap_or(0).min(total);
    let lim = limit.unwrap_or(20).clamp(1, 100);
    let mut body = String::new();
    for (i, (_, id, file, cwd, title, matches, snippet, tools, has_error)) in
        hits.into_iter().skip(off).take(lim).enumerate()
    {
        if i > 0 {
            body.push(',');
        }
        let tools_json = tools
            .iter()
            .map(|t| format!("\"{}\"", escape_json(t)))
            .collect::<Vec<_>>()
            .join(",");
        body.push_str(&format!(
            "{{\"id\":\"{}\",\"file\":\"{}\",\"cwd\":\"{}\",\"title\":\"{}\",\"matches\":{matches},\"snippet\":\"{}\",\"tools\":[{tools_json}],\"hasError\":{has_error}}}",
            escape_json(&id),
            escape_json(&file),
            escape_json(&cwd),
            escape_json(&title),
            escape_json(&snippet),
        ));
    }
    Ok(format!(
        "{{\"total\":{total},\"truncated\":{truncated},\"results\":[{body}]}}"
    ))
}

/// Missões do pi-subagents por projeto, somente leitura (sem runner/daemon).
/// Lê `~/.pi/agent/missions/projects/<hash>/*.json` e devolve resumo por missão.
#[tauri::command]
pub fn missions_status() -> Result<String, String> {
    let home = std::env::var_os("HOME").ok_or("HOME não definido")?;
    missions_status_in(&PathBuf::from(home).join(".pi/agent/missions/projects"))
}

/// Mesma lógica com o diretório explícito — testável sem tocar em `HOME`.
fn missions_status_in(dir: &Path) -> Result<String, String> {
    let mut items: Vec<(String, String)> = Vec::new(); // (updatedAt, json)
    for hash in fs::read_dir(dir).into_iter().flatten().flatten() {
        let hd = hash.path();
        if !hd.is_dir() {
            continue;
        }
        let project = hash.file_name().to_string_lossy().to_string();
        for f in fs::read_dir(&hd).into_iter().flatten().flatten() {
            let p = f.path();
            if p.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let raw = fs::read_to_string(&p).unwrap_or_default();
            let v: serde_json::Value =
                serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null);
            let s = |k: &str| v[k].as_str().unwrap_or("");
            let runs = v["runs"].as_array().map(|a| a.len()).unwrap_or(0);
            items.push((
                s("updatedAt").to_string(),
                format!(
                    "{{\"project\":\"{}\",\"id\":\"{}\",\"title\":\"{}\",\"status\":\"{}\",\"updatedAt\":\"{}\",\"runs\":{},\"cwd\":\"{}\"}}",
                    escape_json(&project),
                    escape_json(s("id")),
                    escape_json(s("title")),
                    escape_json(s("status")),
                    escape_json(s("updatedAt")),
                    runs,
                    escape_json(s("cwd")),
                ),
            ));
        }
    }
    items.sort_by(|a, b| b.0.cmp(&a.0));
    if items.len() > 200 {
        items.truncate(200);
    }
    Ok(format!(
        "[{}]",
        items.into_iter().map(|(_, j)| j).collect::<Vec<_>>().join(",")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static SEQ: AtomicUsize = AtomicUsize::new(0);

    /// Diretório temporário do teste (só std; some no Drop).
    struct Tmp(PathBuf);

    impl Tmp {
        fn new(tag: &str) -> Self {
            let n = SEQ.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!("sightdeck-{}-{tag}-{n}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("criar tmpdir");
            Tmp(dir)
        }

        fn at(&self, rel: &str) -> PathBuf {
            self.0.join(rel)
        }

        /// Cria `rel` com `content`, criando os diretórios pais.
        fn file(&self, rel: &str, content: &str) -> PathBuf {
            let p = self.at(rel);
            if let Some(parent) = p.parent() {
                fs::create_dir_all(parent).expect("criar diretório");
            }
            fs::write(&p, content).expect("escrever arquivo");
            p
        }
    }

    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// JSONL com `n` mensagens, precedido de um record que não é mensagem.
    fn session_file(t: &Tmp, rel: &str, n: usize) -> PathBuf {
        let mut body = String::from("{\"type\":\"session_start\"}\n");
        for i in 0..n {
            body.push_str(&format!("{{\"type\":\"message\",\"id\":{i}}}\n"));
        }
        t.file(rel, &body)
    }

    // ---------- resolve_pi_bin: decisão pura, sem env e sem fs ----------
    // Os testes fixam o sufixo POSIX ("") em `resolve_pi_bin_with`; o wrapper
    // `resolve_pi_bin` aplica `bin_suffix(cfg!(windows))` e é coberto à parte.

    #[test]
    fn pi_bin_finds_fnm_alias_default() {
        let got = resolve_pi_bin_with(None, Some(Path::new("/home/u")), "", |p| {
            p.ends_with(".local/share/fnm/aliases/default/bin/pi")
        });
        assert_eq!(
            got,
            PathBuf::from("/home/u/.local/share/fnm/aliases/default/bin/pi")
        );
    }

    #[test]
    fn pi_bin_env_wins_over_home() {
        let got = resolve_pi_bin_with(Some("/opt/x/pi"), Some(Path::new("/home/u")), "", |_| {
            true
        });
        assert_eq!(got, PathBuf::from("/opt/x/pi"));
    }

    #[test]
    fn pi_bin_blank_env_falls_through() {
        let got = resolve_pi_bin_with(Some("   "), Some(Path::new("/home/u")), "", |p| {
            p.ends_with(".pi/agent/bin/pi")
        });
        assert_eq!(got, PathBuf::from("/home/u/.pi/agent/bin/pi"));
    }

    #[test]
    fn pi_bin_prefers_managed_install_then_local_bin_then_path() {
        let managed = resolve_pi_bin_with(None, Some(Path::new("/home/u")), "", |_| true);
        assert_eq!(managed, PathBuf::from("/home/u/.pi/agent/bin/pi"));

        let local = resolve_pi_bin_with(None, Some(Path::new("/home/u")), "", |p| {
            p.ends_with(".local/bin/pi")
        });
        assert_eq!(local, PathBuf::from("/home/u/.local/bin/pi"));

        assert_eq!(
            resolve_pi_bin_with(None, Some(Path::new("/home/u")), "", |_| false),
            PathBuf::from("pi")
        );
        assert_eq!(
            resolve_pi_bin_with(None, None, "", |_| true),
            PathBuf::from("pi")
        );
    }

    #[test]
    fn bin_suffix_e_exe_so_no_windows() {
        assert_eq!(bin_suffix(true), ".exe");
        assert_eq!(bin_suffix(false), "");
    }

    #[test]
    fn app_info_e_json_com_as_chaves_do_sobre() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&app_info()) else {
            panic!("app_info não devolveu JSON");
        };
        for k in ["piBin", "agent", "sessions", "os"] {
            assert!(v.get(k).is_some(), "faltou a chave {k}");
        }
    }

    #[test]
    fn resolve_pi_bin_with_encontra_pi_exe_no_windows() {
        let got = resolve_pi_bin_with(
            None,
            Some(Path::new(r"C:\Users\u")),
            ".exe",
            |p| p.ends_with(r".local\bin\pi.exe") || p.ends_with(".local/bin/pi.exe"),
        );
        assert_eq!(got.file_name().unwrap(), "pi.exe", "{}", got.display());
        assert!(
            got.ends_with(".local/bin/pi.exe"),
            "{}",
            got.display()
        );
        // nenhum candidato existe: o fallback também leva o sufixo
        assert_eq!(
            resolve_pi_bin_with(None, Some(Path::new(r"C:\Users\u")), ".exe", |_| false),
            PathBuf::from("pi.exe")
        );
    }

    #[test]
    fn resolve_pi_bin_aplica_o_sufixo_do_so_atual() {
        let got = resolve_pi_bin(None, None, |_| false);
        assert_eq!(got, PathBuf::from(format!("pi{}", bin_suffix(cfg!(windows)))));
    }

    // ---------- pick_home: HOME primeiro, USERPROFILE como reserva do Windows ----------

    #[test]
    fn pick_home_prefere_home() {
        let got = pick_home(Some("/home/u".into()), Some(r"C:\Users\u".into()));
        assert_eq!(got, Some(PathBuf::from("/home/u")));
    }

    #[test]
    fn pick_home_cai_para_userprofile() {
        let esperado = Some(PathBuf::from(r"C:\Users\u"));
        assert_eq!(pick_home(None, Some(r"C:\Users\u".into())), esperado);
        assert_eq!(pick_home(Some("".into()), Some(r"C:\Users\u".into())), esperado);
    }

    #[test]
    fn pick_home_none_quando_ambos_vazios() {
        assert_eq!(pick_home(None, None), None);
        assert_eq!(pick_home(Some("".into()), Some("".into())), None);
    }

    // ---------- escape_json ----------

    #[test]
    fn escape_json_covers_quotes_slashes_and_controls() {
        assert_eq!(escape_json("a\"b\\c\nd\re\tf"), "a\\\"b\\\\c\\nd\\re\\tf");
        assert_eq!(escape_json("\u{1}"), "\\u0001");
        assert_eq!(escape_json("\u{0}"), "\\u0000");
        // Não-ASCII passa cru: continua JSON válido e o parser do frontend aceita.
        assert_eq!(escape_json("é—🙂"), "é—🙂");
    }

    // ---------- read_session_messages ----------

    #[test]
    fn read_messages_caps_limit_and_counts_all() {
        let t = Tmp::new("caps");
        let root = t.at("sessions");
        let f = session_file(&t, "sessions/proj/s.jsonl", 300);

        let out = read_session_messages_in(&f, &root, Some(50), None).unwrap();
        assert_eq!(out.lines().count(), 51, "meta + 50 mensagens");

        let meta = out.lines().next().unwrap();
        assert!(meta.contains("\"total\":300"), "{meta}");
        assert!(meta.contains("\"omitted\":250"), "{meta}");
        assert!(meta.contains("\"hasMore\":true"), "{meta}");
    }

    #[test]
    fn read_messages_drops_oversized_line() {
        let t = Tmp::new("huge");
        let root = t.at("sessions");
        let huge = format!(
            "{{\"type\":\"message\",\"payload\":\"{}\"}}\n",
            "x".repeat(70 * 1024)
        );
        let f = t.file(
            "sessions/proj/s.jsonl",
            &format!("{{\"type\":\"message\",\"id\":1}}\n{huge}{{\"type\":\"message\",\"id\":3}}\n"),
        );

        let out = read_session_messages_in(&f, &root, Some(50), None).unwrap();
        let meta = out.lines().next().unwrap();
        assert!(meta.contains("\"oversized\":1"), "{meta}");
        assert!(meta.contains("\"total\":3"), "{meta}");
        assert_eq!(out.lines().count(), 3, "meta + 2 mensagens");
        assert!(!out.contains("xxxxx"), "linha gigante não pode ir ao webview");
    }

    #[test]
    fn read_messages_skip_walks_back_and_clears_has_more() {
        let t = Tmp::new("skip");
        let root = t.at("sessions");
        let f = session_file(&t, "sessions/proj/s.jsonl", 120);

        let out = read_session_messages_in(&f, &root, Some(50), Some(100)).unwrap();
        let meta = out.lines().next().unwrap();
        assert_eq!(out.lines().count() - 1, 20, "120 - 100 = 20 restantes");
        // `skip` anda de trás pra frente: as 100 mais novas já estão na tela,
        // então não sobra nada mais antigo que o retornado.
        assert!(meta.contains("\"omitted\":0"), "{meta}");
        assert!(meta.contains("\"consumed\":120"), "{meta}");
        assert!(meta.contains("\"hasMore\":false"), "{meta}");
        assert!(out.contains("\"id\":0}"), "deveria começar na mais antiga: {out}");
        assert!(
            !out.contains("\"id\":20}"),
            "não deveria alcançar as já carregadas: {out}"
        );
    }

    // ---------- search_sessions: busca global + filtro por tool/erro ----------

    fn search_msg(role: &str, body: &str) -> String {
        format!("{{\"type\":\"message\",\"message\":{{\"role\":\"{role}\",{body}}}}}")
    }

    #[test]
    fn search_matches_text_filters_by_tool_and_error() {
        let t = Tmp::new("search");
        let root = t.at("sessions");
        t.file(
            "sessions/proj/a.jsonl",
            &[
                search_msg(
                    "user",
                    r#""content":[{"type":"text","text":"como deployar no render"}]"#,
                ),
                search_msg(
                    "assistant",
                    r#""content":[{"type":"toolCall","id":"c1","name":"edit","arguments":{"path":"/tmp/a.txt"}}]"#,
                ),
                search_msg(
                    "toolResult",
                    r#""toolCallId":"c1","toolName":"edit","isError":false,"content":[{"type":"text","text":"ok"}]"#,
                ),
            ]
            .join("\n"),
        );
        t.file(
            "sessions/proj/b.jsonl",
            &[
                search_msg(
                    "user",
                    r#""content":[{"type":"text","text":"outro assunto"}]"#,
                ),
                search_msg(
                    "toolResult",
                    r#""toolCallId":"c9","toolName":"bash","isError":true,"content":[{"type":"text","text":"command failed"}]"#,
                ),
            ]
            .join("\n"),
        );

        // Texto: só `a` fala de deploy, e o snippet guarda o trecho.
        let out = search_sessions_in(&root, "deployar", None, false, None, None).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["total"], 1, "{out}");
        assert_eq!(v["results"][0]["id"], "a", "{out}");
        assert!(
            v["results"][0]["snippet"].as_str().unwrap().contains("deployar"),
            "{out}"
        );

        // Filtro por tool (case-insensitive): só `b` usa bash.
        let out = search_sessions_in(&root, "", Some("BASH"), false, None, None).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["total"], 1, "{out}");
        assert_eq!(v["results"][0]["id"], "b", "{out}");

        // Só erros: `a` terminou ok, `b` falhou.
        let out = search_sessions_in(&root, "", None, true, None, None).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["total"], 1, "{out}");
        assert_eq!(v["results"][0]["id"], "b", "{out}");
        assert_eq!(v["results"][0]["hasError"], true, "{out}");

        // Sem nenhum critério não escaneia nada.
        let out = search_sessions_in(&root, "  ", None, false, None, None).unwrap();
        assert!(out.contains("\"total\":0"), "{out}");

        // Paginação: "o" casa nas duas; cada página traz 1, sem repetir.
        let p1 = search_sessions_in(&root, "o", None, false, Some(1), Some(0)).unwrap();
        let p2 = search_sessions_in(&root, "o", None, false, Some(1), Some(1)).unwrap();
        let v1: serde_json::Value = serde_json::from_str(&p1).unwrap();
        let v2: serde_json::Value = serde_json::from_str(&p2).unwrap();
        assert_eq!(v1["total"], 2, "{p1}");
        assert_eq!(v1["results"].as_array().unwrap().len(), 1, "{p1}");
        assert_eq!(v2["results"].as_array().unwrap().len(), 1, "{p2}");
        assert_ne!(v1["results"][0]["id"], v2["results"][0]["id"], "{p1} vs {p2}");
    }

    // ---------- session_edits: arquivos editados + patch ----------

    #[test]
    fn session_edits_pair_tool_calls_with_results() {
        let t = Tmp::new("edits");
        let root = t.at("sessions");
        let patch = "--- /tmp/a.txt\\n+++ /tmp/a.txt\\n@@ -1 +1 @@\\n-a\\n+b\\n";
        let tool_result = format!(
            r#"{{"type":"message","message":{{"role":"toolResult","toolCallId":"c1","toolName":"edit","timestamp":1001,"details":{{"patch":"{patch}"}}}}}}"#
        );
        let main = t.file(
            "sessions/proj/s.jsonl",
            &format!("{}\n{}\n", r#"{"type":"message","message":{"role":"assistant","timestamp":1000,"content":[{"type":"toolCall","id":"c1","name":"edit","arguments":{"path":"/tmp/a.txt","edits":[]}}]}}"#, tool_result),
        );
        // Child com um `write`: não vem patch do resultado, monta de adições.
        t.file(
            "sessions/proj/s/abcd1234efgh/run-0/session.jsonl",
            concat!(
                r#"{"type":"message","message":{"role":"assistant","timestamp":2000,"content":[{"type":"toolCall","id":"c2","name":"write","arguments":{"path":"/tmp/b.txt","content":"linha1\nlinha2"}}]}}"#,
                "\n",
                r#"{"type":"message","message":{"role":"toolResult","toolCallId":"c2","toolName":"write","timestamp":2001,"content":[{"type":"text","text":"Successfully wrote to /tmp/b.txt"}],"isError":false}}"#,
                "\n"
            ),
        );

        let out = session_edits_in(&main, &root).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        let items = parsed.as_array().unwrap();
        assert_eq!(items.len(), 2, "{out}");
        // Mais recente primeiro: o write do child (2001) vem antes do edit (1001).
        assert_eq!(items[0]["file"], "/tmp/b.txt");
        assert_eq!(items[0]["tool"], "write");
        assert_eq!(items[0]["src"], "abcd1234/run-0");
        assert!(items[0]["patch"].as_str().unwrap().contains("+linha1"));
        assert_eq!(items[1]["file"], "/tmp/a.txt");
        assert_eq!(items[1]["src"], "sessão");
        assert!(items[1]["patch"].as_str().unwrap().contains("-a\n+b"));
    }

    #[test]
    fn list_children_lists_runs_inside_root() {
        let t = Tmp::new("childok");
        let root = t.at("sessions");
        t.file("sessions/proj/s.jsonl", "{}\n");
        t.file("sessions/proj/child1/run-0/session.jsonl", "{}\n");
        let out = list_children_in(&t.at("sessions/proj"), &root).unwrap();
        assert!(out.contains("run-0"), "{out}");
    }

    #[test]
    fn list_children_missing_dir_is_empty() {
        // Sessão sem subagent: o diretório de children nunca existiu.
        let t = Tmp::new("childnone");
        let root = t.at("sessions");
        t.file("sessions/proj/s.jsonl", "{}\n");
        let out = list_children_in(&t.at("sessions/proj/s"), &root).unwrap();
        assert_eq!(out, "[]", "{out}");
    }

    #[test]
    fn list_children_rejects_dir_outside_root() {
        let t = Tmp::new("childout");
        let root = t.at("sessions");
        fs::create_dir_all(&root).unwrap();
        let outside = t.at("alheio");
        fs::create_dir_all(&outside).unwrap();
        let err = list_children_in(&outside, &root).unwrap_err();
        assert!(err.contains("fora do diretório permitido"), "{err}");
    }

    #[test]
    fn session_edits_rejects_path_outside_root() {
        let t = Tmp::new("editsout");
        let root = t.at("sessions");
        fs::create_dir_all(&root).expect("criar root");
        let outside = t.file("segredo.jsonl", "{}\n");
        let err = session_edits_in(&outside, &root).unwrap_err();
        // Precisa falhar pela contenção, não por root inexistente.
        assert!(err.contains("fora do diretório permitido"), "{err}");
    }

    #[test]
    fn session_edits_skips_failed_edits() {
        let t = Tmp::new("editserr");
        let root = t.at("sessions");
        let f = t.file(
            "sessions/proj/s.jsonl",
            concat!(
                r#"{"type":"message","message":{"role":"assistant","timestamp":10,"content":[{"type":"toolCall","id":"c1","name":"edit","arguments":{"path":"/tmp/x.txt","edits":[]}}]}}"#,
                "\n",
                r#"{"type":"message","message":{"role":"toolResult","toolCallId":"c1","toolName":"edit","timestamp":11,"isError":true,"content":[{"type":"text","text":"falhou"}]}}"#,
                "\n"
            ),
        );
        let out = session_edits_in(&f, &root).unwrap();
        assert_eq!(out, "[]", "edição com erro não entra na lista: {out}");
    }

    // ---------- containment: o webview não escolhe o que ler/apagar ----------
    #[test]
    fn read_messages_rejects_path_outside_root() {
        let t = Tmp::new("readout");
        let root = t.at("sessions");
        fs::create_dir_all(&root).unwrap();
        let secret = t.file("important.txt", "não deveria vazar");

        let err = read_session_messages_in(&secret, &root, None, None).unwrap_err();
        assert!(err.contains("fora do diretório permitido"), "{err}");
    }

    #[test]
    fn read_messages_rejects_traversal() {
        let t = Tmp::new("trav");
        let root = t.at("sessions");
        t.file("sessions/proj/s.jsonl", "{\"type\":\"message\"}\n");
        t.file("important.txt", "não deveria vazar");

        let trav = t.at("sessions/proj/../../important.txt");
        let err = read_session_messages_in(&trav, &root, None, None).unwrap_err();
        assert!(err.contains("fora do diretório permitido"), "{err}");
    }

    // ---------- open_file: só abre o que está dentro do projeto ----------

    #[test]
    fn open_file_accepts_only_files_inside_project() {
        let t = Tmp::new("open");
        let f = t.file("proj/a.txt", "x");
        assert!(open_file_in(&t.at("proj"), &f).is_ok());
        let outside = t.file("other/b.txt", "x");
        let err = open_file_in(&t.at("proj"), &outside).unwrap_err();
        assert!(err.contains("fora do diretório"), "{err}");
        assert!(open_file_in(&t.at("proj"), &t.at("proj/naoexiste.txt")).is_err());
    }

    // ---------- revert_hunk: desfaz UM hunk do patch exibido ----------

    #[test]
    fn revert_hunk_restores_removed_block_on_exact_single_match() {
        let t = Tmp::new("revok");
        let cwd = t.at("proj");
        let f = t.file("proj/a.txt", "a\nB\nc\n");
        let hunk = "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c";
        let out = revert_hunk_in(&cwd, &f, hunk).unwrap();
        assert!(out.contains("hunk desfeito"), "{out}");
        assert_eq!(fs::read_to_string(&f).unwrap(), "a\nb\nc\n");
    }

    #[test]
    fn revert_hunk_refuses_when_added_block_occurs_twice() {
        let t = Tmp::new("revdup");
        let cwd = t.at("proj");
        let f = t.file("proj/a.txt", "X\nX\n");
        let hunk = "@@ -1 +1 @@\n-Y\n+X";
        let err = revert_hunk_in(&cwd, &f, hunk).unwrap_err();
        assert!(err.contains("2 vezes"), "{err}");
        assert_eq!(fs::read_to_string(&f).unwrap(), "X\nX\n", "nada pode mudar na recusa");
    }

    #[test]
    fn revert_hunk_refuses_truncated_patch() {
        let t = Tmp::new("revtrunc");
        let cwd = t.at("proj");
        let f = t.file("proj/a.txt", "a\nB\n");
        let hunk = "@@ -1,2 +1,2 @@\n a\n-b\n+B\n\u{2026} patch truncado";
        let err = revert_hunk_in(&cwd, &f, hunk).unwrap_err();
        assert!(err.contains("truncado"), "{err}");
        assert_eq!(fs::read_to_string(&f).unwrap(), "a\nB\n", "nada pode mudar na recusa");
    }

    #[test]
    fn revert_hunk_rejects_file_outside_cwd() {
        let t = Tmp::new("revout");
        fs::create_dir_all(t.at("proj")).unwrap();
        let victim = t.file("other/secret.txt", "X\n");
        let hunk = "@@ -1 +1 @@\n-Y\n+X";
        let err = revert_hunk_in(&t.at("proj"), &victim, hunk).unwrap_err();
        assert!(err.contains("fora do diretório permitido"), "{err}");
        assert!(victim.exists(), "arquivo fora do cwd não pode ser tocado");
    }

    #[test]
    fn revert_hunk_refuses_addition_only_write_hunk() {
        let t = Tmp::new("revadd");
        let cwd = t.at("proj");
        let f = t.file("proj/a.txt", "linha1\nlinha2\n");
        let hunk = "+linha1\n+linha2";
        let err = revert_hunk_in(&cwd, &f, hunk).unwrap_err();
        assert!(err.contains("só com adições"), "{err}");
        assert_eq!(fs::read_to_string(&f).unwrap(), "linha1\nlinha2\n", "nada pode mudar na recusa");
    }

    #[test]
    fn revert_hunk_refuses_when_file_changed_since_patch() {
        let t = Tmp::new("revstale");
        let cwd = t.at("proj");
        let f = t.file("proj/a.txt", "a\nZ\nc\n");
        let hunk = "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c";
        let err = revert_hunk_in(&cwd, &f, hunk).unwrap_err();
        assert!(err.contains("não encontrado"), "{err}");
        assert_eq!(fs::read_to_string(&f).unwrap(), "a\nZ\nc\n", "nada pode mudar na recusa");
    }

    #[test]
    fn revert_hunk_refuses_removal_only_hunk() {
        let t = Tmp::new("revrem");
        let cwd = t.at("proj");
        let f = t.file("proj/a.txt", "a\nb\nc\n");
        let hunk = "@@ -1,3 +1,2 @@\n a\n-b\n c";
        let err = revert_hunk_in(&cwd, &f, hunk).unwrap_err();
        assert!(err.contains("só com remoções"), "{err}");
        assert_eq!(fs::read_to_string(&f).unwrap(), "a\nb\nc\n", "nada pode mudar na recusa");
    }

    // ---------- missions_status: resumo somente-leitura por projeto ----------

    #[test]
    fn missions_status_lists_newest_first() {
        let t = Tmp::new("missions");
        t.file(
            "missions/h1/m1.json",
            r#"{"id":"a","title":"T","status":"active","updatedAt":"2026-11-02","runs":[],"cwd":"/x"}"#,
        );
        t.file(
            "missions/h2/m2.json",
            r#"{"id":"b","title":"U","status":"completed","updatedAt":"2026-11-01","runs":[{}],"cwd":"/y"}"#,
        );
        let out = missions_status_in(&t.at("missions")).unwrap();
        assert!(out.find("\"id\":\"a\"").unwrap() < out.find("\"id\":\"b\"").unwrap(), "{out}");
        assert!(out.contains("\"runs\":1"), "{out}");
        assert!(out.contains("\"project\":\"h2\""), "{out}");
    }

    // ---------- delete_session ----------

    #[test]
    fn delete_session_moves_file_and_children_to_trash() {
        let t = Tmp::new("del");
        let root = t.at("sessions");
        let f = t.file("sessions/proj/s.jsonl", "{\"type\":\"message\"}\n");
        t.file("sessions/proj/s/child1/run-1/session.jsonl", "{}\n");

        let out = delete_session_in(&f, &root).unwrap();
        assert!(out.contains("movido para"), "{out}");
        assert!(!f.exists(), "jsonl deveria ter saído do lugar");
        assert!(
            !t.at("sessions/proj/s").exists(),
            "children deveriam ter saído"
        );
        assert!(
            t.at("sessions/proj/.sightdeck-trash/s/s.jsonl").exists(),
            "jsonl deveria estar na lixeira"
        );
        assert!(
            t.at("sessions/proj/.sightdeck-trash/s/s/child1/run-1/session.jsonl")
                .exists(),
            "children deveriam estar na lixeira"
        );
    }

    #[test]
    fn delete_session_rejects_file_outside_root() {
        let t = Tmp::new("delout");
        let root = t.at("sessions");
        fs::create_dir_all(&root).unwrap();
        let victim = t.file("important.txt", "conteúdo");

        let err = delete_session_in(&victim, &root).unwrap_err();
        assert!(err.contains("fora do diretório permitido"), "{err}");
        assert!(victim.exists(), "arquivo fora do root não pode ser movido");
        assert!(
            !t.at(".sightdeck-trash").exists(),
            "nada pode ser criado fora do root"
        );
    }

    // ---------- open_terminal_login: só nome exato da allowlist chega ao shell ----------

    #[test]
    fn login_provider_accepts_known_names_trimmed() {
        assert_eq!(validate_login_provider("  openai  ").unwrap(), "openai");
        assert_eq!(validate_login_provider("anthropic").unwrap(), "anthropic");
        assert_eq!(
            validate_login_provider("xiaomi-token-plan-sgp").unwrap(),
            "xiaomi-token-plan-sgp"
        );
    }

    #[test]
    fn login_provider_rejects_empty_unknown_and_injection() {
        for bad in ["", "   ", "nope", "openai; rm -rf ~", "$(x)", "openai|cat /etc/passwd"] {
            assert!(validate_login_provider(bad).is_err(), "{bad:?} deveria falhar");
        }
    }

    #[test]
    fn login_allowlist_stays_shell_safe() {
        assert!(!LOGIN_PROVIDERS.is_empty(), "allowlist não pode nascer vazia");
        for p in LOGIN_PROVIDERS {
            assert!(
                !p.is_empty() && p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'),
                "{p:?} fora de [a-z0-9-]"
            );
        }
    }

    #[test]
    fn quote_bin_escapa_para_o_shell_do_alvo() {
        // POSIX: single quote com o idioma `'\''` — $, backtick e espaço ficam literais.
        // Windows: double quote (cmd e PowerShell não interpretam single quote).
        let q = quote_bin("/home/u/.local/bin/pi");
        if cfg!(windows) {
            assert_eq!(q, "\"/home/u/.local/bin/pi\"", "{q}");
        } else {
            assert_eq!(q, "'/home/u/.local/bin/pi'", "{q}");
            let com_aspa = quote_bin("/tmp/a'b/pi");
            assert_eq!(com_aspa, r"'/tmp/a'\''b/pi'", "{com_aspa}");
        }
    }

    // ---------- login_inner: pausa final com o dialeto do SO ----------

    #[test]
    fn login_inner_posix_espera_enter_com_read() {
        let s = login_inner("'/home/u/.local/bin/pi'", "openai", false);
        assert!(s.contains("auth login openai"), "{s}");
        assert!(s.contains("read -r _"), "{s}");
        assert!(!s.contains("Read-Host"), "{s}");
    }

    #[test]
    fn login_inner_windows_espera_enter_com_read_host() {
        let s = login_inner("\"C:\\Users\\u\\pi.exe\"", "openai", true);
        assert!(s.contains("auth login openai"), "{s}");
        assert!(s.contains("Read-Host"), "{s}");
        assert!(!s.contains("read -r _"), "{s}");
    }

    // ---------- compactação (settings.json do projeto) ----------

    #[test]
    fn set_model_reserve_preserva_outras_chaves_e_poda_ao_remover() {
        let mut root: serde_json::Value =
            serde_json::from_str(r#"{"compaction":{"enabled":true}}"#).unwrap();
        set_model_reserve(&mut root, "openai/gpt", Some(60000)).unwrap();
        assert_eq!(root["compaction"]["enabled"], serde_json::json!(true));
        assert_eq!(
            root["compaction"]["modelOverrides"]["openai/gpt"]["reserveTokens"],
            serde_json::json!(60000)
        );
        set_model_reserve(&mut root, "openai/gpt", None).unwrap();
        assert!(root["compaction"].get("modelOverrides").is_none(), "{root}");
        assert_eq!(root["compaction"]["enabled"], serde_json::json!(true));
    }

    #[test]
    fn compaction_state_devolve_override_ou_null() {
        let root = serde_json::json!({
            "compaction": { "modelOverrides": { "a/b": { "reserveTokens": 40000 } } }
        });
        let got: serde_json::Value = serde_json::from_str(&compaction_state(&root, "a/b")).unwrap();
        assert_eq!(got["reserveTokens"], serde_json::json!(40000));
        assert!(got["keepRecentTokens"].is_null());
        let none: serde_json::Value = serde_json::from_str(&compaction_state(&root, "x/y")).unwrap();
        assert!(none["reserveTokens"].is_null(), "{none}");
    }

    #[test]
    fn compaction_set_grava_no_settings_do_projeto_e_preserva_resto() {
        let t = Tmp::new("cmpset");
        let cwd = t.at("proj");
        t.file("proj/.pi/settings.json", "{\n  \"theme\": \"x\"\n}\n");

        let out = compaction_set(
            cwd.display().to_string(),
            "p".into(),
            "m".into(),
            Some(40000),
        )
        .unwrap();
        let got: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(got["reserveTokens"], serde_json::json!(40000));

        let disk: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(t.at("proj/.pi/settings.json")).unwrap())
                .unwrap();
        assert_eq!(disk["theme"], serde_json::json!("x"));
        assert_eq!(
            disk["compaction"]["modelOverrides"]["p/m"]["reserveTokens"],
            serde_json::json!(40000)
        );

        // "padrão do pi": remove o override e poda, sem tocar no resto do arquivo.
        let out = compaction_set(cwd.display().to_string(), "p".into(), "m".into(), None).unwrap();
        let got: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(got["reserveTokens"].is_null());
        let disk: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(t.at("proj/.pi/settings.json")).unwrap())
                .unwrap();
        assert!(disk.get("compaction").is_none(), "{disk}");
        assert_eq!(disk["theme"], serde_json::json!("x"));
    }
}
