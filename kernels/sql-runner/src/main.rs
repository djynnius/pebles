//! The SQL session kernel.
//!
//! pebblesd's session broker forks this binary with setuid/setgid to the requesting
//! user, cwd their home. Protocol: JSON lines on stdio. The first line out is a
//! handshake reporting the uid this process ACTUALLY runs as — the broker kills the
//! session if it isn't the requested user.
//!
//! Ops (proto 1): `ping` (identity/cwd report), `read` / `write` (filesystem as the
//! session user — the isolation primitive the smoke test proves). M0.5 replaces the
//! file ops' role with real DuckDB `sql` execution using vendored DuckLake
//! extensions (no runtime INSTALL — NFR-03).
//!
//! Kernels live outside `crates/` and `web/` on purpose: they run *as end users* on
//! engines, and nothing in the web tier may ever execute here.

use serde_json::{json, Value};
use std::io::{BufRead, Write};

const MAX_READ_BYTES: usize = 4096;

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
        other => fail(format!("unknown op {other:?} (proto 1: ping/read/write)")),
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
