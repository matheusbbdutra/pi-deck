//! Aba Plano: lê os markdown de `plans/` do `cwd` da sessão e resume o
//! checklist de cada um (feitos/total, próximo item aberto, mtime). Só leitura:
//! nenhum arquivo é criado ou alterado aqui.
//!
//! O parser é manual (sem crate de regex/markdown): marcador `-`/`*`, um `[ ]` ou
//! `[x]`/`[X]` e o resto como texto. Item dentro de bloco cercado (``` / ~~~)
//! é exemplo de documentação, não progresso, e não conta.

use std::path::Path;
use std::time::UNIX_EPOCH;

/// Teto de arquivos devolvidos (os mais recentes por `mtime`).
const MAX_PLANS: usize = 30;
/// Teto do `current` em caracteres (não bytes: corte sempre em `char`).
const CURRENT_MAX: usize = 80;

/// Um `plans/*.md` já resumido pelo checklist.
#[derive(Debug, Clone, PartialEq)]
pub struct Plano {
    pub file: String,
    pub name: String,
    pub done: u32,
    pub total: u32,
    pub current: Option<String>,
    pub mtime: u64,
}

/// Planos do projeto do `cwd`. `{"repo":false}` quando não existe `plans/`;
/// `Err` só quando o próprio `cwd` não é um diretório legível.
#[tauri::command]
pub fn plans_list(cwd: String) -> Result<String, String> {
    let base = Path::new(&cwd);
    if !base.is_dir() {
        return Err(format!("cwd não é um diretório: {cwd}"));
    }
    let plans_dir = base.join("plans");
    if !plans_dir.is_dir() {
        return Ok("{\"repo\":false}".to_string());
    }
    let entries = std::fs::read_dir(&plans_dir)
        .map_err(|e| format!("não consegui ler {}: {e}", plans_dir.display()))?;
    let mut plans: Vec<Plano> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
        })
        .filter_map(|path| plan_entry(&path, base))
        .collect();
    plans.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    plans.truncate(MAX_PLANS);

    let payload = serde_json::json!({
        "repo": true,
        "plans": plans
            .iter()
            .map(|p| serde_json::json!({
                "file": p.file,
                "name": p.name,
                "done": p.done,
                "total": p.total,
                "current": p.current,
                "mtime": p.mtime,
            }))
            .collect::<Vec<_>>(),
    });
    Ok(payload.to_string())
}

/// Um arquivo de plano; `None` se não dá para ler como UTF-8 (binário, permissão).
fn plan_entry(path: &Path, base: &Path) -> Option<Plano> {
    let md = std::fs::read_to_string(path).ok()?;
    let (done, total, current) = parse_checklist(&md);
    let mtime = std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let rel = path.strip_prefix(base).unwrap_or(path);
    let file = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/");
    Some(Plano {
        name: path.file_stem()?.to_string_lossy().into_owned(),
        file,
        done,
        total,
        current,
        mtime,
    })
}

/// Conta o checklist do markdown: `(feitos, total, primeiro aberto)`.
fn parse_checklist(md: &str) -> (u32, u32, Option<String>) {
    let mut done = 0;
    let mut total = 0;
    let mut current: Option<String> = None;
    let mut in_fence = false;
    for line in md.lines() {
        if is_fence(line) {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        let Some((checked, text)) = checklist_item(line) else {
            continue;
        };
        total += 1;
        if checked {
            done += 1;
        } else if current.is_none() {
            current = Some(shorten(text));
        }
    }
    (done, total, current)
}

/// Linha que abre/fecha bloco cercado (``` ou ~~~, com ou sem linguagem).
fn is_fence(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with("```") || t.starts_with("~~~")
}

/// Item de checklist de uma linha: `Some((concluído, texto))`. Aceita `-`/`*` com
/// espaço depois, `[ ]` aberto e `[x]`/`[X]` fechado, depois de indentação e de
/// qualquer espaço entre o marcador e o `[`. Texto vazio conta como item.
fn checklist_item(line: &str) -> Option<(bool, &str)> {
    let rest = line.trim_start();
    let rest = rest.strip_prefix('-').or_else(|| rest.strip_prefix('*'))?;
    if !rest.starts_with([' ', '\t']) {
        return None;
    }
    let rest = rest.trim_start();
    let bytes = rest.as_bytes();
    if bytes.len() < 3 || bytes[0] != b'[' || bytes[2] != b']' {
        return None;
    }
    let checked = match bytes[1] {
        b' ' => false,
        b'x' | b'X' => true,
        _ => return None,
    };
    Some((checked, rest[3..].trim()))
}

/// `current` em no máximo `CURRENT_MAX` caracteres.
fn shorten(text: &str) -> String {
    if text.chars().count() <= CURRENT_MAX {
        return text.to_string();
    }
    text.chars().take(CURRENT_MAX).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Markdown do `a.md` do cenário: aberto/fechado, `[X]`, `*`, indentado,
    /// linha sem checkbox e um checklist dentro de bloco cercado (não conta).
    const A_MD: &str = "\
# Plano A

- [x] Ler os markdown de plans
- [ ] Implementar watcher
  - [X] Sub-item indentado conta
- [ ] Documentar
* [ ] Item com asterisco
- linha sem checkbox

```md
- [x] exemplo dentro de bloco
- [ ] outro exemplo
```
";

    /// Markdown do `b.md` (mais novo): tudo fechado, sem `current`.
    const B_MD: &str = "\
# Plano B

- [x] Um
- [x] Dois
";

    #[test]
    fn parse_checklist_conta_marcadores_e_ignora_o_resto() {
        assert_eq!(
            parse_checklist(A_MD),
            (2, 5, Some("Implementar watcher".to_string()))
        );
    }

    #[test]
    fn parse_checklist_aceita_x_maiusculo_e_asterisco() {
        assert_eq!(parse_checklist("- [X] fechado\n"), (1, 1, None));
        assert_eq!(parse_checklist("* [ ] aberto\n"), (0, 1, Some("aberto".to_string())));
        assert_eq!(parse_checklist("* [x] fechado\n"), (1, 1, None));
    }

    #[test]
    fn parse_checklist_aceita_indentacao() {
        assert_eq!(
            parse_checklist("  - [ ] indentado\n\t- [x] com tab\n"),
            (1, 2, Some("indentado".to_string()))
        );
    }

    #[test]
    fn parse_checklist_ignora_linha_sem_checkbox() {
        for md in [
            "- item comum\n",
            "texto\n",
            "-[ ] sem espaço\n",
            "- [z] letra inválida\n",
            "```\n", // cerca sem par não vira item
        ] {
            assert_eq!(parse_checklist(md), (0, 0, None), "{md:?}");
        }
        // Item sem texto conta: `[ ]` sozinho é progresso, não exemplo.
        assert_eq!(parse_checklist("- [ ]\n"), (0, 1, Some(String::new())));
    }

    #[test]
    fn parse_checklist_nao_conta_dentro_de_bloco_cercado() {
        let (done, total, current) = parse_checklist("```\n- [x] exemplo\n- [ ] exemplo\n```\n- [ ] real\n");
        assert_eq!((done, total), (0, 1));
        assert_eq!(current, Some("real".to_string()));

        // fence com linguagem e fecho com mais crases
        let (done, total, _) = parse_checklist("~~~text\n- [x] a\n~~~\n- [x] b\n");
        assert_eq!((done, total), (1, 1));
    }

    #[test]
    fn shorten_corta_em_80_caracteres_de_char() {
        let long = "á".repeat(100);
        let cut = shorten(&long);
        assert_eq!(cut.chars().count(), CURRENT_MAX);
        assert_eq!(shorten("curto"), "curto");
    }

    /// Cenário fs: `<dir>/plans/{a.md,b.md}` + um `.txt` que não deve entrar.
    /// `PI_DECK_PLANS_DIR` aponta o cenário para um diretório fixo (prova manual);
    /// sem a variável, o teste cria e apaga um temp dir próprio.
    #[test]
    fn plans_list_ordena_por_mtime_e_conta_os_itens() {
        let fixed = std::env::var("PI_DECK_PLANS_DIR").ok().map(PathBuf::from);
        let dir = match &fixed {
            Some(dir) => dir.clone(),
            None => {
                let dir = std::env::temp_dir()
                    .join(format!("pi-deck-plans-{}", std::process::id()));
                let _ = std::fs::remove_dir_all(&dir);
                std::fs::create_dir_all(dir.join("plans")).unwrap();
                dir
            }
        };
        if fixed.is_none() {
            std::fs::write(dir.join("plans/a.md"), A_MD).unwrap();
            // mtime com resolução de ms no mínimo: 20 ms separam a.md de b.md.
            std::thread::sleep(std::time::Duration::from_millis(20));
            std::fs::write(dir.join("plans/b.md"), B_MD).unwrap();
            std::fs::write(dir.join("plans/notas.txt"), "- [x] não é plano\n").unwrap();
        }

        let payload = plans_list(dir.to_string_lossy().into_owned()).unwrap();
        eprintln!("{payload}");
        let v: serde_json::Value = serde_json::from_str(&payload).expect("json válido");
        if fixed.is_none() {
            let _ = std::fs::remove_dir_all(&dir);
        }

        assert_eq!(v["repo"], true);
        let plans = v["plans"].as_array().expect("array");
        assert_eq!(plans.len(), 2, "só .md: {payload}");

        assert_eq!(plans[0]["file"], "plans/b.md");
        assert_eq!(plans[0]["name"], "b");
        assert_eq!(plans[0]["done"], 2);
        assert_eq!(plans[0]["total"], 2);
        assert!(plans[0]["current"].is_null());
        assert!(plans[0]["mtime"].as_u64().unwrap() > 0);

        assert_eq!(plans[1]["file"], "plans/a.md");
        assert_eq!(plans[1]["name"], "a");
        assert_eq!(plans[1]["done"], 2);
        assert_eq!(plans[1]["total"], 5);
        assert_eq!(plans[1]["current"], "Implementar watcher");
        assert!(plans[1]["mtime"].as_u64().unwrap() < plans[0]["mtime"].as_u64().unwrap());
    }

    #[test]
    fn plans_list_sem_diretorio_plans_devolve_repo_false() {
        let dir = std::env::temp_dir().join(format!("pi-deck-noplans-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let payload = plans_list(dir.to_string_lossy().into_owned()).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(payload, "{\"repo\":false}");
    }

    #[test]
    fn plans_list_recusa_cwd_invalido() {
        let missing = std::env::temp_dir().join(format!("pi-deck-ausente-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&missing);
        let err = plans_list(missing.to_string_lossy().into_owned()).unwrap_err();
        assert!(err.contains("não é um diretório"), "{err}");

        let file = std::env::temp_dir().join(format!("pi-deck-arquivo-{}", std::process::id()));
        std::fs::write(&file, "x").unwrap();
        let err = plans_list(file.to_string_lossy().into_owned()).unwrap_err();
        let _ = std::fs::remove_file(&file);
        assert!(err.contains("não é um diretório"), "{err}");
    }
}
