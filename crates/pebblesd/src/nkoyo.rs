//! Nkoyo (REQ-43): the assistant harness on LOCAL models only. Ollama endpoints
//! are auto-detected across the fleet (the main's host plus every registered
//! engine's host), with separate model choices for planning, code/SQL, and
//! embeddings, and a max-steps cap. No data ever leaves the hosts: the only
//! network calls are to the configured Ollama endpoints.
//!
//! This module is the foundation (config + detection + chat turns). The agentic
//! tool loop — tools running through the invoking user's session so Nkoyo can
//! never exceed their grants (REQ-45) — and Auto ETL build on it next.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const DEFAULT_OLLAMA_PORT: u16 = 11434;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NkoyoConfig {
    /// Ollama base URLs, e.g. `http://10.0.0.7:11434`.
    #[serde(default)]
    pub endpoints: Vec<String>,
    #[serde(default = "default_model")]
    pub planner_model: String,
    #[serde(default = "default_model")]
    pub coder_model: String,
    #[serde(default = "default_embed_model")]
    pub embed_model: String,
    #[serde(default = "default_max_steps")]
    pub max_steps: u32,
    /// Per-tool grade overrides (REQ-45); defaults come from each tool.
    #[serde(default)]
    pub tool_grades: std::collections::HashMap<String, ToolGrade>,
}

fn default_model() -> String {
    "llama3.2".to_string()
}
fn default_embed_model() -> String {
    "nomic-embed-text".to_string()
}
fn default_max_steps() -> u32 {
    16
}

impl Default for NkoyoConfig {
    fn default() -> Self {
        Self {
            endpoints: Vec::new(),
            planner_model: default_model(),
            coder_model: default_model(),
            embed_model: default_embed_model(),
            max_steps: default_max_steps(),
            tool_grades: std::collections::HashMap::new(),
        }
    }
}

fn config_path(config_dir: &Path) -> PathBuf {
    config_dir.join("nkoyo.json")
}

pub fn load(config_dir: &Path) -> NkoyoConfig {
    std::fs::read_to_string(config_path(config_dir))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save(config_dir: &Path, cfg: &NkoyoConfig) -> std::io::Result<()> {
    std::fs::write(
        config_path(config_dir),
        serde_json::to_string_pretty(cfg).expect("serializable"),
    )
}

/// Candidate Ollama endpoints: the main's own host plus every registered
/// engine's host, each on the standard Ollama port (REQ-43 fleet detection).
pub fn candidates(engine_addresses: &[String]) -> Vec<String> {
    let mut out = vec![format!("http://127.0.0.1:{DEFAULT_OLLAMA_PORT}")];
    for address in engine_addresses {
        if let Some(host) = address
            .trim_start_matches("http://")
            .trim_start_matches("https://")
            .split([':', '/'])
            .next()
        {
            let candidate = format!("http://{host}:{DEFAULT_OLLAMA_PORT}");
            if !out.contains(&candidate) {
                out.push(candidate);
            }
        }
    }
    out
}

#[derive(Debug, Clone, Serialize)]
pub struct DetectedEndpoint {
    pub endpoint: String,
    pub models: Vec<String>,
}

/// Probe one candidate: `GET /api/tags` names the models it serves.
pub async fn probe(http: &reqwest::Client, endpoint: &str) -> Option<DetectedEndpoint> {
    let resp = http
        .get(format!("{endpoint}/api/tags"))
        .timeout(std::time::Duration::from_secs(2))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: serde_json::Value = resp.json().await.ok()?;
    let models = body["models"]
        .as_array()?
        .iter()
        .filter_map(|m| m["name"].as_str().map(str::to_string))
        .collect();
    Some(DetectedEndpoint {
        endpoint: endpoint.to_string(),
        models,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// Graded tool permission (REQ-45). `always_on` runs without prompting;
/// `ask_first` runs only when the user pre-authorized it this turn; `blocked`
/// never runs. Nkoyo can never exceed the user's grants regardless of grade,
/// because every tool executes through the user's own session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolGrade {
    AlwaysOn,
    AskFirst,
    Blocked,
}

/// A tool Nkoyo may call. `op` is the session-kernel op it maps to; read-only
/// tools default always-on, mutating ones ask-first, and shell blocked.
pub struct Tool {
    pub name: &'static str,
    pub description: &'static str,
    pub op: &'static str,
    pub default_grade: ToolGrade,
    /// JSON-schema of the arguments (for the Ollama `tools` param).
    pub parameters: serde_json::Value,
}

pub fn tools() -> Vec<Tool> {
    use serde_json::json;
    vec![
        Tool {
            name: "list_catalogs",
            description: "List the lake catalogs the user can access.",
            op: "list_catalogs",
            default_grade: ToolGrade::AlwaysOn,
            parameters: json!({"type": "object", "properties": {}}),
        },
        Tool {
            name: "sql_query",
            description: "Run a read-only SQL query (SELECT/SHOW/DESCRIBE/WITH) against a catalog.",
            op: "sql",
            default_grade: ToolGrade::AlwaysOn,
            parameters: json!({
                "type": "object",
                "properties": {
                    "sql": {"type": "string"},
                    "catalog": {"type": "string"}
                },
                "required": ["sql"]
            }),
        },
        Tool {
            name: "list_files",
            description: "List files in a directory of the user's home.",
            op: "browse",
            default_grade: ToolGrade::AlwaysOn,
            parameters: json!({
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"]
            }),
        },
        Tool {
            name: "read_file",
            description: "Read a text file from the user's home.",
            op: "read",
            default_grade: ToolGrade::AlwaysOn,
            parameters: json!({
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"]
            }),
        },
        Tool {
            name: "write_file",
            description: "Write a text file into the user's home (mutating).",
            op: "write",
            default_grade: ToolGrade::AskFirst,
            parameters: json!({
                "type": "object",
                "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
                "required": ["path", "content"]
            }),
        },
        Tool {
            name: "sql_exec",
            description: "Run a mutating SQL statement (CREATE/INSERT/UPDATE/DELETE) — ask first.",
            op: "sql",
            default_grade: ToolGrade::AskFirst,
            parameters: json!({
                "type": "object",
                "properties": {"sql": {"type": "string"}, "catalog": {"type": "string"}},
                "required": ["sql"]
            }),
        },
        Tool {
            name: "create_catalog",
            description: "Create a new lake catalog owned by the user (ask first). \
                          Name: letters, digits, underscore; not starting with a digit.",
            op: "create_catalog",
            default_grade: ToolGrade::AskFirst,
            parameters: json!({
                "type": "object",
                "properties": {"name": {"type": "string"}},
                "required": ["name"]
            }),
        },
        Tool {
            name: "create_schema",
            description: "Create a schema inside a catalog the user can write to (ask first).",
            op: "sql",
            default_grade: ToolGrade::AskFirst,
            parameters: json!({
                "type": "object",
                "properties": {"catalog": {"type": "string"}, "name": {"type": "string"}},
                "required": ["catalog", "name"]
            }),
        },
        Tool {
            name: "create_notebook",
            description: "Create a notebook in the user's ~/notebooks (ask first). Cells run \
                          top to bottom; type is sql, python, r or md. Never overwrites.",
            op: "create_notebook",
            default_grade: ToolGrade::AskFirst,
            parameters: json!({
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "lowercase, digits, - and _"},
                    "catalog": {"type": "string"},
                    "cells": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "type": {"type": "string", "enum": CELL_TYPES},
                                "source": {"type": "string"}
                            },
                            "required": ["type", "source"]
                        }
                    }
                },
                "required": ["name", "cells"]
            }),
        },
        Tool {
            name: "create_job",
            description: "Create a job (a workflow of tasks that runs as the user, manually \
                          or on a cron schedule) — ask first. Never overwrites an existing job.",
            op: "create_job",
            default_grade: ToolGrade::AskFirst,
            parameters: json!({
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "lowercase, digits, - and _"},
                    "schedule": {"type": "string", "description": "cron, or omit for manual"},
                    "tasks": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {"type": "string"},
                                "task_type": {"type": "string", "enum": ["sql", "python", "r", "shell", "notebook"]},
                                "payload": {"type": "string", "description": "the code, or a notebook path for notebook tasks"},
                                "catalog": {"type": "string"},
                                "depends_on": {"type": "array", "items": {"type": "string"}}
                            },
                            "required": ["id", "task_type", "payload"]
                        }
                    }
                },
                "required": ["name", "tasks"]
            }),
        },
    ]
}

/// Notebook cell types (web `notebooks.CELL_TYPES`).
const CELL_TYPES: [&str; 4] = ["sql", "python", "r", "md"];

/// Unquoted SQL identifier (catalog/schema names), as the web tier enforces.
fn is_ident(s: &str) -> bool {
    let mut chars = s.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        && s.len() <= 63
}

/// Notebook/job document names (web `DOC_NAME`).
fn is_doc_name(s: &str) -> bool {
    let mut chars = s.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
        && s.len() <= 64
}

/// A read-only SQL guard for the always-on `sql_query` tool: the first keyword
/// must be SELECT/WITH/SHOW/DESCRIBE/EXPLAIN/PRAGMA and there is exactly one
/// statement.
pub fn is_read_only_sql(sql: &str) -> bool {
    let trimmed = sql.trim().trim_end_matches(';');
    if trimmed.contains(';') {
        return false; // no statement chaining
    }
    let first = trimmed
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_uppercase();
    matches!(
        first.as_str(),
        "SELECT" | "WITH" | "SHOW" | "DESCRIBE" | "DESC" | "EXPLAIN" | "PRAGMA" | "SUMMARIZE"
    )
}

/// Effective grade for a tool given the config overrides.
pub fn grade_of(cfg: &NkoyoConfig, tool: &Tool) -> ToolGrade {
    cfg.tool_grades
        .get(tool.name)
        .copied()
        .unwrap_or(tool.default_grade)
}

/// Full built-in skill text Nkoyo carries in its prompt; past this, even
/// built-in skills are indexed.
const SKILL_TEXT_BUDGET: usize = 24 * 1024;

/// Load folder-based skills (REQ-44) into the prompt section. Built-in
/// (workspace, e.g. pebbles-guide) skills are inlined while they fit the
/// budget; the user's installed skills are always an *index* — name,
/// description, path — that Nkoyo reads with read_file when one applies. A
/// large installed skill (a PDF toolkit, say) inlined on every turn drowned
/// the guide and derailed unrelated answers in the live test.
pub fn load_skills(home: &Path) -> String {
    let read = |dir: PathBuf| -> Vec<(String, PathBuf, String)> {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return Vec::new();
        };
        let mut found: Vec<_> = entries.flatten().collect();
        found.sort_by_key(|e| e.file_name());
        found
            .into_iter()
            .filter_map(|entry| {
                let skill_md = entry.path().join("SKILL.md");
                let text = std::fs::read_to_string(&skill_md).ok()?;
                let name = entry.file_name().to_string_lossy().into_owned();
                Some((name, skill_md, text.trim().to_string()))
            })
            .collect()
    };
    let index_line = |name: &str, path: &Path, text: &str| {
        format!(
            "- {name}: {} (read_file {})",
            skill_description(text),
            path.display()
        )
    };
    let mut out = String::new();
    let mut indexed = Vec::new();
    let mut used = 0;
    for (name, path, text) in read(PathBuf::from("/opt/pebbles/skills")) {
        if used + text.len() <= SKILL_TEXT_BUDGET {
            used += text.len();
            out.push_str("\n\n## Skill: ");
            out.push_str(&name);
            out.push('\n');
            out.push_str(&text);
        } else {
            indexed.push(index_line(&name, &path, &text));
        }
    }
    for (name, path, text) in read(home.join(".pebbles/skills")) {
        indexed.push(index_line(&name, &path, &text));
    }
    if !indexed.is_empty() {
        out.push_str(
            "\n\n## The user's skills\nOnly when a request matches one of these, \
             read its SKILL.md with read_file first and follow it; otherwise ignore them.\n",
        );
        out.push_str(&indexed.join("\n"));
    }
    out
}

/// A skill's front-matter `description:`, else its first prose line.
fn skill_description(text: &str) -> String {
    let mut lines = text.lines();
    if lines.next().map(str::trim) == Some("---") {
        for line in lines.by_ref() {
            if line.trim() == "---" {
                break;
            }
            if let Some(d) = line.strip_prefix("description:") {
                return d.trim().trim_matches(['"', '\'']).to_string();
            }
        }
    }
    text.lines()
        .map(|l| l.trim().trim_start_matches('#').trim())
        .find(|l| !l.is_empty() && *l != "---")
        .unwrap_or_default()
        .chars()
        .take(200)
        .collect()
}

/// Map a requested tool call to its session-kernel op payload, enforcing the
/// grade and the read-only SQL guard. Returns the op payload to run through the
/// user's session, or an Err message the model should see (refusal/guidance).
/// Pure — the caller supplies the actual session executor.
pub fn plan_tool_call(
    cfg: &NkoyoConfig,
    approved: &[String],
    name: &str,
    args: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let all = tools();
    let tool = all
        .iter()
        .find(|t| t.name == name)
        .ok_or_else(|| format!("no such tool {name:?}"))?;

    match grade_of(cfg, tool) {
        ToolGrade::Blocked => return Err(format!("tool {name:?} is blocked by policy")),
        ToolGrade::AskFirst if !approved.iter().any(|a| a == name) => {
            return Err(format!(
                "tool {name:?} needs the user's approval before it can run"
            ));
        }
        _ => {}
    }

    let op = match (tool.op, name) {
        ("list_catalogs", _) => serde_json::json!({"op": "list_catalogs"}),
        ("sql", "sql_query") => {
            let sql = args["sql"].as_str().unwrap_or_default();
            if !is_read_only_sql(sql) {
                return Err("sql_query is read-only; use sql_exec (ask-first) to modify".into());
            }
            serde_json::json!({"op": "sql", "sql": sql, "catalog": args["catalog"]})
        }
        ("sql", "create_schema") => {
            let (catalog, schema) = (
                args["catalog"].as_str().unwrap_or_default(),
                args["name"].as_str().unwrap_or_default(),
            );
            if !is_ident(catalog) || !is_ident(schema) {
                return Err("catalog and schema names are letters, digits and _".into());
            }
            serde_json::json!({
                "op": "sql",
                "sql": format!("CREATE SCHEMA \"{catalog}\".\"{schema}\""),
                "catalog": catalog,
            })
        }
        ("sql", _) => {
            serde_json::json!({"op": "sql", "sql": args["sql"], "catalog": args["catalog"]})
        }
        ("browse", _) => serde_json::json!({"op": "browse", "path": args["path"]}),
        ("read", _) => serde_json::json!({"op": "read", "path": args["path"]}),
        ("write", _) => {
            serde_json::json!({"op": "write", "path": args["path"], "content": args["content"]})
        }
        ("create_catalog", _) => {
            let name = args["name"].as_str().unwrap_or_default();
            if !is_ident(name) {
                return Err("catalog names are letters, digits and _".into());
            }
            serde_json::json!({"op": "create_catalog", "name": name})
        }
        ("create_notebook", _) => {
            let name = args["name"].as_str().unwrap_or_default();
            if !is_doc_name(name) {
                return Err("notebook names are lowercase letters, digits, - and _".into());
            }
            let cells: Vec<serde_json::Value> = args["cells"]
                .as_array()
                .map(|cells| {
                    cells
                        .iter()
                        .filter(|c| CELL_TYPES.contains(&c["type"].as_str().unwrap_or("")))
                        .map(|c| serde_json::json!({"type": c["type"], "source": c["source"].as_str().unwrap_or_default()}))
                        .collect()
                })
                .unwrap_or_default();
            if cells.is_empty() {
                return Err("a notebook needs at least one sql/python/r/md cell".into());
            }
            let catalog = args["catalog"].as_str().filter(|c| is_ident(c));
            let doc = serde_json::json!({"catalog": catalog, "cells": cells});
            serde_json::json!({
                "op": "create_notebook",
                "name": name,
                "path": format!("notebooks/{name}.json"),
                "content": doc.to_string(),
            })
        }
        ("create_job", _) => {
            let name = args["name"].as_str().unwrap_or_default();
            if !is_doc_name(name) {
                return Err("job names are lowercase letters, digits, - and _".into());
            }
            // The owner is filled in by the caller from the asker — the model
            // never chooses whom a job runs as (REQ-41/45).
            serde_json::json!({
                "op": "create_job",
                "name": name,
                "schedule": args["schedule"].as_str().filter(|s| !s.trim().is_empty()),
                "tasks": args["tasks"],
            })
        }
        _ => return Err(format!("tool {name:?} has no runner")),
    };
    Ok(op)
}

/// System prompt = base persona + loaded skills + a note that everything runs as
/// the user (REQ-45).
pub fn system_prompt(username: &str, skills: &str) -> String {
    format!(
        "You are Nkoyo, the data assistant inside Pebbles. You are helping {username}. \
         Every tool you call runs as {username} in their own session — you can never \
         see or touch anything they cannot. Prefer read-only tools; use the lake and \
         their files to answer concretely. When they ask how to do something in \
         Pebbles, answer from the pebbles-guide skill with the exact screens and \
         clicks; offer to do it for them when a tool can. Tools that change \
         anything (create_*, write_file, sql_exec) need their approval: say what \
         you will do and ask, rather than calling the tool unannounced. Keep \
         answers concise.{skills}"
    )
}

/// SKILL.md drafting (Settings → Agent skills): one plain completion on the
/// coder model — no tools, no data access; the user reviews before saving.
pub async fn draft_skill(
    http: &reqwest::Client,
    cfg: &NkoyoConfig,
    name: &str,
    description: &str,
) -> Result<String, String> {
    let endpoint = cfg
        .endpoints
        .first()
        .ok_or_else(|| "no Ollama endpoints configured".to_string())?;
    let system = "You write agent skills for Nkoyo, the assistant inside Pebbles (a \
        self-hosted data platform: catalogs/schemas/tables in a DuckDB lake, notebooks, \
        SQL editor, dashboards, jobs). A skill is one Markdown file, SKILL.md: YAML \
        front matter with `name` and a one-line `description` (when to use it), then \
        concise instructions, conventions and examples. Output ONLY the file content.";
    let prompt = format!("Skill name: {name}\n\nWhat it should do:\n{description}");
    let resp = http
        .post(format!("{endpoint}/api/chat"))
        .timeout(std::time::Duration::from_secs(120))
        .json(&serde_json::json!({
            "model": cfg.coder_model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
            "stream": false,
        }))
        .send()
        .await
        .map_err(|e| format!("{endpoint}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "{endpoint}: HTTP {} for model {}",
            resp.status(),
            cfg.coder_model
        ));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(strip_fence(
        body["message"]["content"].as_str().unwrap_or_default(),
    ))
}

/// Models like to wrap a file in ``` fences; the SKILL.md is the inside.
fn strip_fence(text: &str) -> String {
    let t = text.trim();
    if let Some(rest) = t.strip_prefix("```") {
        let body = rest.split_once('\n').map(|(_, b)| b).unwrap_or("");
        return body.trim_end().trim_end_matches("```").trim().to_string();
    }
    t.to_string()
}

/// Ollama tool schema for the `tools` request param.
pub fn tool_schema() -> serde_json::Value {
    serde_json::Value::Array(
        tools()
            .iter()
            .map(|t| {
                serde_json::json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.parameters,
                    }
                })
            })
            .collect(),
    )
}

/// One agentic turn (REQ-43/45): drive the planner model with tools, execute
/// each tool call through the user's session via `run_op`, loop until the model
/// answers with text or `max_steps` is hit. `run_op` is the ONLY way tools touch
/// the system — it runs as the user, so Nkoyo is bounded by their grants.
///
/// Returns (final answer, trace of tool names run).
pub async fn agent_turn<F, Fut>(
    http: &reqwest::Client,
    cfg: &NkoyoConfig,
    system: &str,
    user_messages: &[ChatMessage],
    approved: &[String],
    mut run_op: F,
) -> Result<(String, Vec<String>), String>
where
    F: FnMut(serde_json::Value) -> Fut,
    Fut: std::future::Future<Output = Result<serde_json::Value, String>>,
{
    if cfg.endpoints.is_empty() {
        return Err("no Ollama endpoints configured".into());
    }
    let endpoint = cfg.endpoints[0].clone();
    let mut messages: Vec<serde_json::Value> = vec![serde_json::json!({
        "role": "system", "content": system
    })];
    for m in user_messages {
        messages.push(serde_json::json!({"role": m.role, "content": m.content}));
    }

    let mut trace = Vec::new();
    for _ in 0..cfg.max_steps.max(1) {
        let resp = http
            .post(format!("{endpoint}/api/chat"))
            .timeout(std::time::Duration::from_secs(120))
            .json(&serde_json::json!({
                "model": cfg.planner_model,
                "messages": messages,
                "tools": tool_schema(),
                "stream": false,
            }))
            .send()
            .await
            .map_err(|e| format!("{endpoint}: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("{endpoint}: HTTP {}", resp.status()));
        }
        let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        let message = &body["message"];
        let tool_calls = message["tool_calls"]
            .as_array()
            .cloned()
            .unwrap_or_default();

        if tool_calls.is_empty() {
            // Final answer.
            return Ok((
                message["content"].as_str().unwrap_or_default().to_string(),
                trace,
            ));
        }
        // Echo the assistant's tool-call turn, then append each result.
        messages.push(message.clone());
        for call in tool_calls {
            let name = call["function"]["name"].as_str().unwrap_or_default();
            let args = call["function"]["arguments"].clone();
            trace.push(name.to_string());
            let result = match plan_tool_call(cfg, approved, name, &args) {
                Ok(op) => run_op(op)
                    .await
                    .unwrap_or_else(|e| serde_json::json!({"ok": false, "error": e})),
                Err(refusal) => serde_json::json!({"ok": false, "error": refusal}),
            };
            messages.push(serde_json::json!({
                "role": "tool",
                "content": result.to_string(),
            }));
        }
    }
    Ok((
        "I reached the step limit before finishing — try narrowing the question.".to_string(),
        trace,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approved_none() -> Vec<String> {
        vec![]
    }

    #[test]
    fn read_only_sql_guard() {
        assert!(is_read_only_sql("SELECT * FROM t"));
        assert!(is_read_only_sql("  with x as (select 1) select * from x;"));
        assert!(is_read_only_sql("DESCRIBE claims"));
        assert!(!is_read_only_sql("DROP TABLE t"));
        assert!(!is_read_only_sql("INSERT INTO t VALUES (1)"));
        assert!(!is_read_only_sql("SELECT 1; DROP TABLE t")); // no chaining
    }

    #[test]
    fn always_on_read_tools_run_but_read_only_sql_is_enforced() {
        let cfg = NkoyoConfig::default();
        let op = plan_tool_call(
            &cfg,
            &approved_none(),
            "sql_query",
            &serde_json::json!({"sql": "SELECT 1", "catalog": "claims"}),
        )
        .unwrap();
        assert_eq!(op["op"], "sql");
        // A mutating statement through the read-only tool is refused.
        assert!(plan_tool_call(
            &cfg,
            &approved_none(),
            "sql_query",
            &serde_json::json!({"sql": "DELETE FROM t"})
        )
        .is_err());
    }

    #[test]
    fn ask_first_tools_need_approval_blocked_never_run() {
        let mut cfg = NkoyoConfig::default();
        // write_file defaults ask-first.
        assert!(plan_tool_call(
            &cfg,
            &approved_none(),
            "write_file",
            &serde_json::json!({"path": "a.txt", "content": "x"})
        )
        .is_err());
        // Approved this turn → runs.
        let ok = plan_tool_call(
            &cfg,
            &["write_file".to_string()],
            "write_file",
            &serde_json::json!({"path": "a.txt", "content": "x"}),
        );
        assert!(ok.is_ok());
        // Blocked by config → never, even if approved.
        cfg.tool_grades
            .insert("write_file".into(), ToolGrade::Blocked);
        assert!(plan_tool_call(
            &cfg,
            &["write_file".to_string()],
            "write_file",
            &serde_json::json!({"path": "a.txt", "content": "x"})
        )
        .is_err());
    }

    #[test]
    fn create_tools_are_ask_first_and_validate_names() {
        let cfg = NkoyoConfig::default();
        for tool in [
            "create_catalog",
            "create_schema",
            "create_notebook",
            "create_job",
        ] {
            let t = tools().into_iter().find(|t| t.name == tool).unwrap();
            assert_eq!(grade_of(&cfg, &t), ToolGrade::AskFirst, "{tool}");
        }
        let ok = |name: &str, args: serde_json::Value| {
            plan_tool_call(&cfg, &[name.to_string()], name, &args)
        };
        let op = ok(
            "create_schema",
            serde_json::json!({"catalog": "claims", "name": "raw"}),
        )
        .unwrap();
        assert_eq!(op["sql"], "CREATE SCHEMA \"claims\".\"raw\"");
        // Injection through a name is refused, not quoted around.
        assert!(ok(
            "create_schema",
            serde_json::json!({"catalog": "c", "name": "x\"; DROP"})
        )
        .is_err());
        assert!(ok("create_catalog", serde_json::json!({"name": "1bad"})).is_err());
        let nb = ok(
            "create_notebook",
            serde_json::json!({"name": "q1", "cells": [{"type": "sql", "source": "SELECT 1"}, {"type": "bash", "source": "rm"}]}),
        )
        .unwrap();
        assert_eq!(nb["path"], "notebooks/q1.json");
        let doc: serde_json::Value = serde_json::from_str(nb["content"].as_str().unwrap()).unwrap();
        assert_eq!(doc["cells"].as_array().unwrap().len(), 1); // unknown cell type dropped
        assert!(ok(
            "create_notebook",
            serde_json::json!({"name": "../x", "cells": []})
        )
        .is_err());
        let job = ok(
            "create_job",
            serde_json::json!({"name": "nightly", "tasks": []}),
        )
        .unwrap();
        assert!(job.get("username").is_none()); // owner is never model-chosen
    }

    #[test]
    fn skill_drafts_lose_their_code_fence() {
        assert_eq!(
            strip_fence("```markdown\n---\nname: x\n---\nbody\n```"),
            "---\nname: x\n---\nbody"
        );
        assert_eq!(strip_fence("  plain  "), "plain");
    }

    #[test]
    fn skills_load_from_home_dir() {
        let dir = tempfile::tempdir().unwrap();
        let skill = dir.path().join(".pebbles/skills/claims-helper");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(skill.join("SKILL.md"), "Use the claims catalog for HEDIS.").unwrap();
        let loaded = load_skills(dir.path());
        assert!(loaded.contains("claims-helper"));
        assert!(loaded.contains("HEDIS")); // no front matter: first line is the description
    }

    #[test]
    fn personal_skills_are_indexed_not_inlined() {
        let dir = tempfile::tempdir().unwrap();
        let skill = dir.path().join(".pebbles/skills/pdf");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(
            skill.join("SKILL.md"),
            "---\nname: pdf\ndescription: Work with PDF files.\n---\nhuge body",
        )
        .unwrap();
        let loaded = load_skills(dir.path());
        assert!(loaded.contains("- pdf: Work with PDF files. (read_file "));
        assert!(!loaded.contains("huge body"));
    }

    #[test]
    fn candidates_cover_main_and_engine_hosts_once() {
        let engines = vec![
            "http://10.0.0.7:7443".to_string(),
            "http://10.0.0.7:7443".to_string(), // duplicate host collapses
            "https://10.0.0.9:7443".to_string(),
        ];
        let c = candidates(&engines);
        assert_eq!(
            c,
            vec![
                "http://127.0.0.1:11434",
                "http://10.0.0.7:11434",
                "http://10.0.0.9:11434",
            ]
        );
    }

    #[test]
    fn config_round_trips_with_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let loaded = load(dir.path());
        assert_eq!(loaded.max_steps, 16);
        assert!(loaded.endpoints.is_empty());

        let mut cfg = loaded;
        cfg.endpoints = vec!["http://127.0.0.1:11434".into()];
        cfg.planner_model = "qwen3".into();
        save(dir.path(), &cfg).unwrap();
        let again = load(dir.path());
        assert_eq!(again.planner_model, "qwen3");
        assert_eq!(again.endpoints.len(), 1);
    }
}
