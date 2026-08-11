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
            json!({"id": id, "ok": true, "rows": last_json_array(&stdout)})
        }
        Ok(out) => {
            let mut stderr = String::from_utf8_lossy(&out.stderr).into_owned();
            stderr.truncate(MAX_READ_BYTES);
            fail(stderr.trim().to_string())
        }
        Err(e) => fail(format!("cannot run duckdb: {e}")),
    }
}

/// A lazily-spawned persistent cell executor (Python or R): a child of THIS
/// process (so it runs as the session user, with the miniforge runtimes on
/// PATH — REQ-51), kept alive so cell state persists across executions.
struct LineExec {
    stdin: std::process::ChildStdin,
    stdout: std::io::BufReader<std::process::ChildStdout>,
    child: std::process::Child,
}

/// Per-session executors, one per language.
#[derive(Default)]
struct Executors {
    python: Option<LineExec>,
    r: Option<LineExec>,
}

const PYEXEC: &str = "/opt/pebbles/kernels/pyexec.py";
const REXEC: &str = "/opt/pebbles/kernels/rexec.R";

fn run_cell(
    id: &Value,
    lang: &str,
    code: &str,
    slot: &mut Option<LineExec>,
    program: &str,
    script: &str,
) -> Value {
    use std::io::{BufRead, Write};
    let fail = |err: String| json!({"id": id, "ok": false, "error": err});

    if slot.is_none() {
        let spawned = std::process::Command::new(program)
            .arg(script)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit())
            .spawn();
        match spawned {
            Ok(mut child) => {
                let stdin = child.stdin.take().expect("piped stdin");
                let stdout = std::io::BufReader::new(child.stdout.take().expect("piped stdout"));
                *slot = Some(LineExec {
                    stdin,
                    stdout,
                    child,
                });
            }
            Err(e) => return fail(format!("cannot start {lang} executor: {e}")),
        }
    }
    let exec = slot.as_mut().expect("just ensured");
    let request = json!({ "code": code }).to_string();
    let round_trip = (|| -> std::io::Result<String> {
        exec.stdin.write_all(request.as_bytes())?;
        exec.stdin.write_all(b"\n")?;
        exec.stdin.flush()?;
        let mut reply = String::new();
        exec.stdout.read_line(&mut reply)?;
        Ok(reply)
    })();
    match round_trip {
        Ok(reply) if !reply.trim().is_empty() => match serde_json::from_str::<Value>(&reply) {
            Ok(mut value) => {
                value["id"] = id.clone();
                value
            }
            Err(e) => fail(format!("bad {lang} reply: {e}")),
        },
        _ => {
            // The executor died (or never answered): reap it and let the next
            // cell start a fresh interpreter.
            if let Some(mut dead) = slot.take() {
                let _ = dead.child.kill();
                let _ = dead.child.wait();
            }
            fail(format!(
                "{lang} executor exited; state reset — run the cell again"
            ))
        }
    }
}

/// The last complete JSON array in the CLI's stdout — the caller's final statement.
/// `-json` prints one array per result-bearing statement, and multi-row arrays span
/// MULTIPLE lines (`[{…},` / `{…},` / `{…}]`), so this joins from the last line that
/// opens an array to the end of the output.
fn last_json_array(stdout: &str) -> Value {
    let lines: Vec<&str> = stdout.lines().collect();
    lines
        .iter()
        .rposition(|l| l.starts_with('['))
        .and_then(|i| serde_json::from_str(&lines[i..].join("\n")).ok())
        .unwrap_or(Value::Null)
}

fn getuid() -> u32 {
    // SAFETY: getuid/getgid cannot fail.
    unsafe { libc::getuid() }
}

fn getgid() -> u32 {
    unsafe { libc::getgid() }
}

fn handle(request: &Value, executors: &mut Executors) -> Value {
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
            (Some(path), Some(content)) => {
                if let Some(parent) = std::path::Path::new(path).parent() {
                    if !parent.as_os_str().is_empty() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                }
                match std::fs::write(path, content) {
                    Ok(()) => json!({"id": id, "ok": true}),
                    Err(e) => fail(e.to_string()),
                }
            }
            _ => fail("write needs a path and content".into()),
        },
        Some("list") => match request.get("path").and_then(Value::as_str) {
            Some(path) => match std::fs::read_dir(path) {
                Ok(entries) => {
                    let mut names: Vec<String> = entries
                        .filter_map(|e| e.ok()?.file_name().into_string().ok())
                        .collect();
                    names.sort();
                    json!({"id": id, "ok": true, "entries": names})
                }
                Err(e) => fail(e.to_string()),
            },
            None => fail("list needs a path".into()),
        },
        Some("sql") => match request.get("sql").and_then(Value::as_str) {
            Some(sql) => run_sql(&id, sql, request.get("catalog").and_then(Value::as_str)),
            None => fail("sql needs a sql string".into()),
        },
        Some("python") => match request.get("code").and_then(Value::as_str) {
            Some(code) => run_cell(
                &id,
                "python",
                code,
                &mut executors.python,
                "python3",
                PYEXEC,
            ),
            None => fail("python needs a code string".into()),
        },
        Some("r") => match request.get("code").and_then(Value::as_str) {
            Some(code) => run_cell(&id, "r", code, &mut executors.r, "Rscript", REXEC),
            None => fail("r needs a code string".into()),
        },
        other => fail(format!(
            "unknown op {other:?} (proto 1: ping/read/write/list/sql/python/r)"
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
    let mut executors = Executors::default();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Value>(&line) {
            Ok(request) => handle(&request, &mut executors),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_single_line_and_multi_line_result_arrays() {
        assert_eq!(last_json_array("[{\"c\":3}]"), json!([{"c": 3}]));
        // Multi-row: the CLI spreads one array over several lines, and earlier
        // statements may have printed arrays of their own.
        let multi =
            "[{\"a\":1}]\n[{\"snapshot_id\":0},\n{\"snapshot_id\":1},\n{\"snapshot_id\":2}]";
        assert_eq!(
            last_json_array(multi),
            json!([{"snapshot_id": 0}, {"snapshot_id": 1}, {"snapshot_id": 2}])
        );
        assert_eq!(last_json_array("no arrays here"), Value::Null);
    }
}
