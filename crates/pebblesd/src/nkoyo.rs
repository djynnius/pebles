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
    ]
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

/// Load folder-based skills (REQ-44): `SKILL.md` files under the personal and
/// workspace skill dirs. Returns their concatenated text for the system prompt.
pub fn load_skills(home: &Path) -> String {
    let dirs = [
        home.join(".pebbles/skills"),
        PathBuf::from("/opt/pebbles/skills"),
    ];
    let mut out = String::new();
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let skill_md = entry.path().join("SKILL.md");
            if let Ok(text) = std::fs::read_to_string(&skill_md) {
                out.push_str("\n\n## Skill: ");
                out.push_str(&entry.file_name().to_string_lossy());
                out.push('\n');
                out.push_str(text.trim());
            }
        }
    }
    out
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
        ("sql", _) => {
            serde_json::json!({"op": "sql", "sql": args["sql"], "catalog": args["catalog"]})
        }
        ("browse", _) => serde_json::json!({"op": "browse", "path": args["path"]}),
        ("read", _) => serde_json::json!({"op": "read", "path": args["path"]}),
        ("write", _) => {
            serde_json::json!({"op": "write", "path": args["path"], "content": args["content"]})
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
         their files to answer concretely. Keep answers concise.{skills}"
    )
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
    fn skills_load_from_home_dir() {
        let dir = tempfile::tempdir().unwrap();
        let skill = dir.path().join(".pebbles/skills/claims-helper");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(skill.join("SKILL.md"), "Use the claims catalog for HEDIS.").unwrap();
        let loaded = load_skills(dir.path());
        assert!(loaded.contains("claims-helper"));
        assert!(loaded.contains("HEDIS"));
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
