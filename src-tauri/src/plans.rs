//! Aba Plano: lê os markdown de plano/spec do `cwd` da sessão e resume o
//! checklist de cada um (feitos/total, próximo item aberto, mtime). Só leitura:
//! nenhum arquivo é criado ou alterado aqui.
//!
//! As fontes são procuradas por prioridade — `plans/`, `docs|doc/plans/`, `specs/`
//! e variantes, arquivos soltos conhecidos na raiz (`PLAN.md`, `TASKS.md`, …) e
//! `docs/*.plan.md` — e cada entrada diz de que pasta veio (`source`). Projeto
//! fora desses nomes continua sem aparecer: nenhuma varredura recursiva.
//!
//! O parser é manual (sem crate de regex/markdown): marcador `-`/`*`, um `[ ]` ou
//! `[x]`/`[X]` e o resto como texto. Item dentro de bloco cercado (``` / ~~~)
//! é exemplo de documentação, não progresso, e não conta.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Teto de arquivos devolvidos (de todas as fontes somadas).
const MAX_PLANS: usize = 30;

/// Pastas candidatas (`cwd`-relativas) com a prioridade da fonte: a menor
/// prioridade vem primeiro no JSON, antes do desempate por `mtime`.
const DIR_SOURCES: &[(&str, u8)] = &[
    ("plans", 0),
    ("docs/plans", 1),
    ("doc/plans", 1),
    ("specs", 2),
    ("spec", 2),
    ("docs/specs", 2),
    ("docs/spec", 2),
];

/// Arquivos soltos de nome conhecido, na prioridade 3.
const FILE_SOURCES: &[&str] = &[
    "PLAN.md",
    "Plan.md",
    "plan.md",
    "TASKS.md",
    "TODO.md",
    "SPEC.md",
    "docs/PLAN.md",
];
const FILE_PRIORITY: u8 = 3;

/// Pasta varrida por `*.plan.md`, na prioridade 4. A candidata aqui é o arquivo,
/// não a pasta: `docs/` sozinho não faz o projeto "ter plano".
const GLOB_DIR: &str = "docs";
const GLOB_SUFFIX: &str = ".plan.md";
const GLOB_PRIORITY: u8 = 4;

/// Teto do `current` em caracteres (não bytes: corte sempre em `char`).
const CURRENT_MAX: usize = 80;

/// Um markdown de plano já resumido pelo checklist. `source` é a pasta de onde
/// ele veio (`plans`, `docs/spec`, …) ou `raiz` quando está na raiz do projeto.
#[derive(Debug, Clone, PartialEq)]
pub struct Plano {
    pub file: String,
    pub name: String,
    pub source: String,
    pub done: u32,
    pub total: u32,
    pub current: Option<String>,
    pub mtime: u64,
}

/// Planos do projeto do `cwd`. `{"repo":false}` só quando nenhuma fonte existe
/// (pasta candidata ausente e nenhum arquivo solto); pasta existente sem `.md`
/// devolve `{"repo":true,"plans":[]}`. `Err` quando o `cwd` não é um diretório
/// legível ou uma pasta candidata não abre.
#[tauri::command]
pub fn plans_list(cwd: String) -> Result<String, String> {
    let base = Path::new(&cwd);
    if !base.is_dir() {
        return Err(format!("cwd não é um diretório: {cwd}"));
    }
    let (found, candidates) = collect_candidates(base)?;

    // Dedupe por path canônico: o mesmo arquivo achado por duas fontes conta uma
    // vez, valendo a primeira ocorrência (menor prioridade, `file` dela).
    let mut seen: Vec<PathBuf> = Vec::new();
    let mut plans: Vec<(u8, Plano)> = Vec::new();
    for (path, priority) in candidates {
        let key = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        if let Some(entry) = plan_entry(&path, base) {
            plans.push((priority, entry));
        }
    }
    plans.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.mtime.cmp(&a.1.mtime)));
    plans.truncate(MAX_PLANS);

    if !found {
        return Ok("{\"repo\":false}".to_string());
    }
    let payload = serde_json::json!({
        "repo": true,
        "plans": plans
            .iter()
            .map(|(_, p)| serde_json::json!({
                "file": p.file,
                "name": p.name,
                "source": p.source,
                "done": p.done,
                "total": p.total,
                "current": p.current,
                "mtime": p.mtime,
            }))
            .collect::<Vec<_>>(),
    });
    Ok(payload.to_string())
}

/// Candidatos a plano do projeto: `(alguma fonte existe?, arquivos com a
/// prioridade da fonte)`. A ordem devolvida já é a de prioridade.
fn collect_candidates(base: &Path) -> Result<(bool, Vec<(PathBuf, u8)>), String> {
    let mut found = false;
    let mut files: Vec<(PathBuf, u8)> = Vec::new();

    for (dir, priority) in DIR_SOURCES {
        let path = base.join(dir);
        if !path.is_dir() {
            continue;
        }
        found = true;
        files.extend(dir_markdowns(&path)?.into_iter().map(|md| (md, *priority)));
    }

    for name in FILE_SOURCES {
        let path = base.join(name);
        if path.is_file() {
            found = true;
            files.push((path, FILE_PRIORITY));
        }
    }

    let glob_dir = base.join(GLOB_DIR);
    if glob_dir.is_dir() {
        for md in dir_markdowns(&glob_dir)? {
            let is_glob = md
                .file_name()
                .is_some_and(|n| n.to_string_lossy().to_ascii_lowercase().ends_with(GLOB_SUFFIX));
            if is_glob {
                found = true;
                files.push((md, GLOB_PRIORITY));
            }
        }
    }

    Ok((found, files))
}

/// `.md` soltos em `dir` (não recursivo), em ordem de leitura do diretório.
fn dir_markdowns(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let entries =
        std::fs::read_dir(dir).map_err(|e| format!("não consegui ler {}: {e}", dir.display()))?;
    Ok(entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
        })
        .collect())
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
    let Some(source) = rel.parent().map(rel_slash) else {
        return None;
    };
    Some(Plano {
        name: path.file_stem()?.to_string_lossy().into_owned(),
        file: rel_slash(rel),
        source: if source.is_empty() { "raiz".to_string() } else { source },
        done,
        total,
        current,
        mtime,
    })
}

/// Caminho relativo com `/` como separador (vazio para a raiz).
fn rel_slash(rel: &Path) -> String {
    rel.components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
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

    /// Temp dir exclusivo deste teste. Prefixo próprio porque os testes rodam em
    /// paralelo no mesmo processo: o pid sozinho não separa os cenários.
    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sightdeck-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Cenário fs: `<dir>/plans/{a.md,b.md}` + um `.txt` que não deve entrar.
    /// `SIGHTDECK_PLANS_DIR` aponta o cenário para um diretório fixo (prova manual);
    /// sem a variável, o teste cria e apaga um temp dir próprio.
    #[test]
    fn plans_list_ordena_por_mtime_e_conta_os_itens() {
        let fixed = std::env::var("SIGHTDECK_PLANS_DIR").ok().map(PathBuf::from);
        let dir = match &fixed {
            Some(dir) => dir.clone(),
            None => temp_dir("plans"),
        };
        if fixed.is_none() {
            std::fs::create_dir_all(dir.join("plans")).unwrap();
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
        assert_eq!(plans[0]["source"], "plans");
        assert_eq!(plans[0]["done"], 2);
        assert_eq!(plans[0]["total"], 2);
        assert!(plans[0]["current"].is_null());
        assert!(plans[0]["mtime"].as_u64().unwrap() > 0);

        assert_eq!(plans[1]["file"], "plans/a.md");
        assert_eq!(plans[1]["name"], "a");
        assert_eq!(plans[1]["source"], "plans");
        assert_eq!(plans[1]["done"], 2);
        assert_eq!(plans[1]["total"], 5);
        assert_eq!(plans[1]["current"], "Implementar watcher");
        assert!(plans[1]["mtime"].as_u64().unwrap() < plans[0]["mtime"].as_u64().unwrap());
    }

    #[test]
    fn plans_list_le_spec_fora_de_plans_com_a_pasta_como_source() {
        let dir = temp_dir("docs-spec");
        std::fs::create_dir_all(dir.join("docs/spec")).unwrap();
        std::fs::write(dir.join("docs/spec/x.md"), A_MD).unwrap();

        let payload = plans_list(dir.to_string_lossy().into_owned()).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        let v: serde_json::Value = serde_json::from_str(&payload).expect("json válido");

        assert_eq!(v["repo"], true);
        let plans = v["plans"].as_array().expect("array");
        assert_eq!(plans.len(), 1, "{payload}");
        assert_eq!(plans[0]["file"], "docs/spec/x.md");
        assert_eq!(plans[0]["source"], "docs/spec");
        assert_eq!(plans[0]["name"], "x");
        assert_eq!(plans[0]["done"], 2);
        assert_eq!(plans[0]["total"], 5);
    }

    /// Mesmo arquivo em duas fontes (symlink): conta uma vez, com o `file` e o
    /// `source` da fonte de maior prioridade.
    #[cfg(unix)]
    #[test]
    fn plans_list_nao_duplica_o_mesmo_arquivo_em_duas_fontes() {
        let dir = temp_dir("dedupe");
        std::fs::create_dir_all(dir.join("plans")).unwrap();
        std::fs::create_dir_all(dir.join("docs/plans")).unwrap();
        std::fs::write(dir.join("plans/a.md"), A_MD).unwrap();
        std::os::unix::fs::symlink(dir.join("plans/a.md"), dir.join("docs/plans/a.md")).unwrap();

        let payload = plans_list(dir.to_string_lossy().into_owned()).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        let v: serde_json::Value = serde_json::from_str(&payload).expect("json válido");

        let plans = v["plans"].as_array().expect("array");
        assert_eq!(plans.len(), 1, "mesmo arquivo conta uma vez: {payload}");
        assert_eq!(plans[0]["file"], "plans/a.md");
        assert_eq!(plans[0]["source"], "plans");
    }

    #[test]
    fn plans_list_le_arquivo_solto_da_raiz_como_source_raiz() {
        let dir = temp_dir("raiz");
        std::fs::write(dir.join("PLAN.md"), B_MD).unwrap();

        let payload = plans_list(dir.to_string_lossy().into_owned()).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        let v: serde_json::Value = serde_json::from_str(&payload).expect("json válido");

        assert_eq!(v["repo"], true);
        let plans = v["plans"].as_array().expect("array");
        assert_eq!(plans.len(), 1, "{payload}");
        assert_eq!(plans[0]["file"], "PLAN.md");
        assert_eq!(plans[0]["source"], "raiz");
        assert_eq!(plans[0]["name"], "PLAN");
        assert_eq!(plans[0]["done"], 2);
        assert_eq!(plans[0]["total"], 2);
    }

    #[test]
    fn plans_list_le_plan_md_solto_em_docs() {
        let dir = temp_dir("docs-glob");
        std::fs::create_dir_all(dir.join("docs")).unwrap();
        std::fs::write(dir.join("docs/entrega.plan.md"), B_MD).unwrap();

        let payload = plans_list(dir.to_string_lossy().into_owned()).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        let v: serde_json::Value = serde_json::from_str(&payload).expect("json válido");

        let plans = v["plans"].as_array().expect("array");
        assert_eq!(plans.len(), 1, "{payload}");
        assert_eq!(plans[0]["file"], "docs/entrega.plan.md");
        assert_eq!(plans[0]["source"], "docs");
        assert_eq!(plans[0]["name"], "entrega.plan");
    }

    /// `source` de maior prioridade vence mesmo com `mtime` menor. Três fontes com
    /// mtime crescente: `plans/` (mais velho) antes de `docs/spec/` antes da raiz.
    /// Imprime o payload: `cargo test prioriza_a_fonte -- --nocapture`.
    #[test]
    fn plans_list_prioriza_a_fonte_antes_do_mtime() {
        let dir = temp_dir("prioridade");
        std::fs::create_dir_all(dir.join("plans")).unwrap();
        std::fs::create_dir_all(dir.join("docs/spec")).unwrap();
        std::fs::write(dir.join("plans/a.md"), A_MD).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(dir.join("docs/spec/mais-novo.md"), B_MD).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(dir.join("PLAN.md"), B_MD).unwrap();

        let payload = plans_list(dir.to_string_lossy().into_owned()).unwrap();
        eprintln!("{payload}");
        let _ = std::fs::remove_dir_all(&dir);
        let v: serde_json::Value = serde_json::from_str(&payload).expect("json válido");

        let plans = v["plans"].as_array().expect("array");
        assert_eq!(plans.len(), 3, "{payload}");
        assert_eq!(plans[0]["file"], "plans/a.md");
        assert_eq!(plans[0]["source"], "plans");
        assert_eq!(plans[1]["file"], "docs/spec/mais-novo.md");
        assert_eq!(plans[1]["source"], "docs/spec");
        assert_eq!(plans[2]["file"], "PLAN.md");
        assert_eq!(plans[2]["source"], "raiz");
        assert!(
            plans[0]["mtime"].as_u64().unwrap() < plans[1]["mtime"].as_u64().unwrap()
                && plans[1]["mtime"].as_u64().unwrap() < plans[2]["mtime"].as_u64().unwrap(),
            "prioridade vence mtime: {payload}"
        );
    }

    #[test]
    fn plans_list_pasta_sem_md_devolve_repo_true_e_lista_vazia() {
        let dir = temp_dir("vazia");
        std::fs::create_dir_all(dir.join("specs")).unwrap();
        std::fs::write(dir.join("specs/notas.txt"), "- [x] não é plano\n").unwrap();

        let payload = plans_list(dir.to_string_lossy().into_owned()).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        let v: serde_json::Value = serde_json::from_str(&payload).expect("json válido");

        assert_eq!(v["repo"], true, "{payload}");
        assert_eq!(v["plans"].as_array().map(|a| a.len()), Some(0), "{payload}");
    }

    #[test]
    fn plans_list_sem_candidato_devolve_repo_false() {
        let dir = temp_dir("noplans");
        let payload = plans_list(dir.to_string_lossy().into_owned()).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(payload, "{\"repo\":false}");
    }

    #[test]
    fn plans_list_recusa_cwd_invalido() {
        let missing = std::env::temp_dir().join(format!("sightdeck-ausente-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&missing);
        let err = plans_list(missing.to_string_lossy().into_owned()).unwrap_err();
        assert!(err.contains("não é um diretório"), "{err}");

        let file = std::env::temp_dir().join(format!("sightdeck-arquivo-{}", std::process::id()));
        std::fs::write(&file, "x").unwrap();
        let err = plans_list(file.to_string_lossy().into_owned()).unwrap_err();
        let _ = std::fs::remove_file(&file);
        assert!(err.contains("não é um diretório"), "{err}");
    }
}
