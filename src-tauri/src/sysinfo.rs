//! Consumo de memória do app e dos processos do `pi` em execução.
//!
//! Linux: `/proc/<pid>/status` (VmRSS) e `/proc/<pid>/cmdline` para achar os
//! processos cujo argv[0] é o binário do pi. Em outros SOs devolve zeros — o
//! app tem suporte real só a Linux (ver README), e mentir número seria pior.

use serde_json::json;
use std::path::Path;

/// RSS em kB de um PID, lendo `VmRSS` de `/proc/<pid>/status`.
fn rss_kb(pid: u32) -> Option<u64> {
    let status = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix("VmRSS:") {
            return rest.split_whitespace().next()?.parse().ok();
        }
    }
    None
}

/// Soma RSS dos processos cujo argv[0] resolve para o binário do pi.
fn pi_rss(pi: &Path) -> (u64, usize) {
    let target = std::fs::canonicalize(pi).unwrap_or_else(|_| pi.to_path_buf());
    let mut total = 0u64;
    let mut count = 0usize;
    let Ok(dir) = std::fs::read_dir("/proc") else {
        return (0, 0);
    };
    for entry in dir.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|s| s.parse::<u32>().ok())
        else {
            continue;
        };
        let Ok(cmd) = std::fs::read(format!("/proc/{pid}/cmdline")) else {
            continue;
        };
        if cmd.is_empty() {
            continue;
        }
        let first = cmd.split(|b| *b == 0).next().unwrap_or(&[]);
        let first = String::from_utf8_lossy(first);
        let matches = first == target.to_string_lossy()
            || std::fs::canonicalize(first.as_ref())
                .map(|p| p == target)
                .unwrap_or(false);
        if !matches {
            continue;
        }
        if let Some(kb) = rss_kb(pid) {
            total += kb;
            count += 1;
        }
    }
    (total, count)
}

/// JSON `{ appKb, piKb, piCount }` — usado pelo monitor perto da versão do pi.
#[tauri::command]
pub fn mem_usage() -> Result<String, String> {
    let app_kb = rss_kb(std::process::id()).unwrap_or(0);
    let (pi_kb, pi_count) = pi_rss(&crate::sessions::pi_bin());
    Ok(json!({
        "appKb": app_kb,
        "piKb": pi_kb,
        "piCount": pi_count,
    })
    .to_string())
}
