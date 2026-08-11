//! The SQL session kernel.
//!
//! pebblesd's session broker forks this binary with setuid/setgid to the requesting
//! user, cwd their home. Protocol: JSON lines on stdio. The first line out is a
//! handshake reporting the uid this process ACTUALLY runs as — the broker kills the
//! session if it isn't the requested user.
//!
//! Ops (proto 1): `ping` (identity/cwd report), `read` / `write` (filesystem as the
//! session user — the isolation primitive the smoke test proves), and `sql` — real
//! DuckDB with the DuckLake catalog in Postgres. SQL runs by driving the official
//! DuckDB CLI (`-json`) per request AS THIS PROCESS'S USER, loading only the
//! extensions vendored into the image (no runtime INSTALL — NFR-03). Session state
//! lives in the catalog + Parquet files, not process memory, so per-request CLI
//! invocation loses nothing that DuckLake doesn't keep.
//!
//! Kernels live outside `crates/` and `web/` on purpose: they run *as end users* on
//! engines, and nothing in the web tier may ever execute here.

use serde_json::{json, Value};
use std::io::{BufRead, Write};

const MAX_READ_BYTES: usize = 4096;
const MAX_RESULT_BYTES: usize = 262_144;
const EXTENSION_DIR: &str = "/opt/pebbles/duckdb/extensions";

fn lake_root() -> String {
    std::env::var("PEBBLES_LAKE_ROOT").unwrap_or_else(|_| "/var/lib/pebbles/lake".to_string())
}

/// Catalog names reach ATTACH strings and paths; keep them boring.
fn valid_catalog(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 31
        && name.chars().next().is_some_and(|c| c.is_ascii_lowercase())
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// Run one SQL request through the DuckDB CLI, attaching the named DuckLake catalog
/// (Postgres over the local socket, peer-authenticated as this uid).
fn run_sql(id: &Value, sql: &str, catalog: Option<&str>) -> Value {
    let fail = |err: String| json!({"id": id, "ok": false, "error": err});

    let mut script = format!(
        "SET autoinstall_known_extensions=false; SET autoload_known_extensions=false; \
         SET extension_directory='{EXTENSION_DIR}'; LOAD ducklake; LOAD postgres;"
    );
    if let Ok(limit) = std::env::var("PEBBLES_SESSION_MEMORY_BYTES") {
        if let Ok(bytes) = limit.parse::<u64>() {
            script.push_str(&format!(
                " SET memory_limit='{}MiB';",
                bytes / (1024 * 1024)
            ));
        }
    }
    if let Some(name) = catalog {
        if !valid_catalog(name) {
            return fail(format!("invalid catalog name {name:?}"));
        }
        script.push_str(&format!(
            " ATTACH 'ducklake:postgres:dbname=ducklake_{name} host=/run/postgresql' \
             AS {name} (DATA_PATH '{}/{name}'); USE {name};",
            lake_root()
        ));
    }
    script.push('\n');
    script.push_str(sql);

    let output = std::process::Command::new("duckdb")
        .args([":memory:", "-json", "-c", &script])
        .output();
    match output {
        Ok(out) if out.status.success() => {
            let mut stdout = String::from_utf8_lossy(&out.stdout).into_owned();
            stdout.truncate(MAX_RESULT_BYTES);
            // -json prints one compact JSON array per result-bearing statement; the
            // last one is the caller's final statement.
            let rows: Value = stdout
                .lines()
                .rev()
                .find(|l| l.starts_with('['))
                .and_then(|l| serde_json::from_str(l).ok())
                .unwrap_or(Value::Null);
            json!({"id": id, "ok": true, "rows": rows})
        }
        Ok(out) => {
            let mut stderr = String::from_utf8_lossy(&out.stderr).into_owned();
            stderr.truncate(MAX_READ_BYTES);
            fail(stderr.trim().to_string())
        }
        Err(e) => fail(format!("cannot run duckdb: {e}")),
    }
}

fn getuid() -> u32 {
    // SAFETY: getuid/getgid cannot fail.
    unsafe { libc::getuid() }
}

fn getgid() -> u32 {
    unsafe { libc::getgid() }
}

fn handle(request: &Value) -> Value {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let fail = |err: String| json!({"id": id, "ok": false, "error": err});

    match request.get("op").and_then(Value::as_str) {
        Some("ping") => json!({
            "id": id,
            "ok": true,
            "uid": getuid(),
            "gid": getgid(),
            "cwd": std::env::current_dir().map(|p| p.display().to_string()).unwrap_or_default(),
            "memory_limit_bytes": std::env::var("PEBBLES_SESSION_MEMORY_BYTES").ok(),
        }),
        Some("read") => match request.get("path").and_then(Value::as_str) {
            Some(path) => match std::fs::read_to_string(path) {
                Ok(mut content) => {
                    content.truncate(MAX_READ_BYTES);
                    json!({"id": id, "ok": true, "content": content})
                }
                Err(e) => fail(e.to_string()),
            },
            None => fail("read needs a path".into()),
        },
        Some("write") => match (
            request.get("path").and_then(Value::as_str),
            request.get("content").and_then(Value::as_str),
        ) {
            (Some(path), Some(content)) => match std::fs::write(path, content) {
                Ok(()) => json!({"id": id, "ok": true}),
                Err(e) => fail(e.to_string()),
            },
            _ => fail("write needs a path and content".into()),
        },
        Some("sql") => match request.get("sql").and_then(Value::as_str) {
            Some(sql) => run_sql(&id, sql, request.get("catalog").and_then(Value::as_str)),
            None => fail("sql needs a sql string".into()),
        },
        other => fail(format!(
            "unknown op {other:?} (proto 1: ping/read/write/sql)"
        )),
    }
}

fn main() {
    let stdout = std::io::stdout();
    let hello = json!({
        "kernel": "sql-runner",
        "proto": 1,
        "version": env!("CARGO_PKG_VERSION"),
        "uid": getuid(),
        "gid": getgid(),
    });
    {
        let mut out = stdout.lock();
        writeln!(out, "{hello}").expect("stdout");
        out.flush().expect("stdout");
    }

    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Value>(&line) {
            Ok(request) => handle(&request),
            Err(e) => json!({"id": null, "ok": false, "error": format!("bad request: {e}")}),
        };
        let mut out = stdout.lock();
        if writeln!(out, "{response}")
            .and_then(|()| out.flush())
            .is_err()
        {
            break;
        }
    }
}
