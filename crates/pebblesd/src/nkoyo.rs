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

/// One chat turn against the first reachable configured endpoint. `which`
/// selects the per-function model (REQ-43): "planner" | "coder" | "embed".
pub async fn chat(
    http: &reqwest::Client,
    cfg: &NkoyoConfig,
    which: &str,
    messages: &[ChatMessage],
) -> Result<(String, String, String), String> {
    if cfg.endpoints.is_empty() {
        return Err(
            "no Ollama endpoints configured — add one under Settings → Nkoyo (models run \
             locally; nothing leaves your hosts)"
                .to_string(),
        );
    }
    let model = match which {
        "coder" => &cfg.coder_model,
        "embed" => &cfg.embed_model,
        _ => &cfg.planner_model,
    };
    let mut last_err = "no endpoint reachable".to_string();
    for endpoint in &cfg.endpoints {
        let resp = http
            .post(format!("{endpoint}/api/chat"))
            .timeout(std::time::Duration::from_secs(120))
            .json(&serde_json::json!({
                "model": model,
                "messages": messages,
                "stream": false,
            }))
            .send()
            .await;
        match resp {
            Ok(resp) if resp.status().is_success() => {
                let body: serde_json::Value = resp
                    .json()
                    .await
                    .map_err(|e| format!("bad Ollama reply: {e}"))?;
                let content = body["message"]["content"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string();
                return Ok((content, model.clone(), endpoint.clone()));
            }
            Ok(resp) => {
                last_err = format!("{endpoint}: HTTP {}", resp.status());
            }
            Err(e) => {
                last_err = format!("{endpoint}: {e}");
            }
        }
    }
    Err(last_err)
}

#[cfg(test)]
mod tests {
    use super::*;

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
