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

/// Minimal standard-base64 decoder (file uploads arrive base64 over JSON; no dep
/// worth pulling for this). Ignores whitespace; returns None on invalid input.
fn b64_decode(s: &str) -> Option<Vec<u8>> {
    fn val(c: u8) -> Option<u8> {
        match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let mut out = Vec::new();
    let mut buf = 0u32;
    let mut bits = 0u32;
    for &c in s.as_bytes() {
        if c == b'=' || c.is_ascii_whitespace() {
            continue;
        }
        let v = val(c)? as u32;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Some(out)
}

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
        // On the main, peer auth over the unix socket. On a remote engine
        // (M2.5b), TCP to the main's Postgres — libpq authenticates with the
        // scram credential pebblesd provisioned into this user's ~/.pgpass.
        let host =
            std::env::var("PEBBLES_CATALOG_HOST").unwrap_or_else(|_| "/run/postgresql".to_string());
        let port = std::env::var("PEBBLES_CATALOG_PORT").unwrap_or_else(|_| "5432".to_string());
        script.push_str(&format!(
            " ATTACH 'ducklake:postgres:dbname=ducklake_{name} host={host} port={port}' \
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

/// Git subcommands the session may run (REQ-33): the porcelain loop only. The
/// command executes AS THIS PROCESS'S USER with their own credentials (~/.ssh,
/// ~/.git-credentials) — pebblesd never holds a shared GitHub credential.
const GIT_ALLOWED: &[&str] = &[
    "clone",
    "status",
    "add",
    "restore",
    "commit",
    "push",
    "pull",
    "fetch",
    "branch",
    "checkout",
    "switch",
    "diff",
    "log",
    "remote",
    "config",
    "init",
    "rev-parse",
    "ls-files",
    // read a file AT A REF without touching the working tree — the repo-ref
    // workflow tasks' (REQ-37) reproducibility primitive
    "show",
];

fn run_git(id: &Value, args: &[String], cwd: Option<&str>) -> Value {
    let fail = |err: String| json!({"id": id, "ok": false, "error": err});
    match args.first().map(String::as_str) {
        Some(sub) if GIT_ALLOWED.contains(&sub) => {}
        Some(sub) => return fail(format!("git subcommand {sub:?} is not allowed")),
        None => return fail("git needs args".into()),
    }
    let mut cmd = std::process::Command::new("git");
    cmd.args(args)
        // Never hang a session on an interactive prompt.
        .env("GIT_TERMINAL_PROMPT", "0")
        .env(
            "GIT_SSH_COMMAND",
            "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
        );
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    match cmd.output() {
        Ok(out) => {
            let mut stdout = String::from_utf8_lossy(&out.stdout).into_owned();
            stdout.truncate(MAX_RESULT_BYTES);
            let mut stderr = String::from_utf8_lossy(&out.stderr).into_owned();
            stderr.truncate(MAX_READ_BYTES);
            json!({
                "id": id,
                "ok": out.status.success(),
                "stdout": stdout,
                "stderr": stderr,
                "exit_code": out.status.code(),
            })
        }
        Err(e) => fail(format!("cannot run git: {e}")),
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
        // Richer directory listing for the Files screen: name, dir?, size, mtime.
        Some("browse") => match request.get("path").and_then(Value::as_str) {
            Some(path) => match std::fs::read_dir(path) {
                Ok(entries) => {
                    let mut items: Vec<Value> = entries
                        .filter_map(|e| {
                            let e = e.ok()?;
                            let meta = e.metadata().ok()?;
                            let mtime = meta
                                .modified()
                                .ok()
                                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                                .map(|d| d.as_secs())
                                .unwrap_or(0);
                            Some(json!({
                                "name": e.file_name().into_string().ok()?,
                                "dir": meta.is_dir(),
                                "size": meta.len(),
                                "mtime": mtime,
                            }))
                        })
                        .collect();
                    items.sort_by(|a, b| {
                        (b["dir"].as_bool(), a["name"].as_str())
                            .cmp(&(a["dir"].as_bool(), b["name"].as_str()))
                    });
                    json!({"id": id, "ok": true, "items": items})
                }
                Err(e) => fail(e.to_string()),
            },
            None => fail("browse needs a path".into()),
        },
        // File upload: base64 content written as raw bytes (parents created).
        Some("upload") => match (
            request.get("path").and_then(Value::as_str),
            request.get("b64").and_then(Value::as_str),
        ) {
            (Some(path), Some(b64)) => match b64_decode(b64) {
                Some(bytes) => {
                    if let Some(parent) = std::path::Path::new(path).parent() {
                        if !parent.as_os_str().is_empty() {
                            let _ = std::fs::create_dir_all(parent);
                        }
                    }
                    match std::fs::write(path, bytes) {
                        Ok(()) => json!({"id": id, "ok": true}),
                        Err(e) => fail(e.to_string()),
                    }
                }
                None => fail("invalid base64".into()),
            },
            _ => fail("upload needs a path and b64".into()),
        },
        Some("mkdir") => match request.get("path").and_then(Value::as_str) {
            Some(path) => match std::fs::create_dir_all(path) {
                Ok(()) => json!({"id": id, "ok": true}),
                Err(e) => fail(e.to_string()),
            },
            None => fail("mkdir needs a path".into()),
        },
        Some("delete") => match request.get("path").and_then(Value::as_str) {
            Some(path) => {
                let meta = std::fs::symlink_metadata(path);
                let result = match meta {
                    Ok(m) if m.is_dir() => std::fs::remove_dir_all(path),
                    Ok(_) => std::fs::remove_file(path),
                    Err(e) => Err(e),
                };
                match result {
                    Ok(()) => json!({"id": id, "ok": true}),
                    Err(e) => fail(e.to_string()),
                }
            }
            None => fail("delete needs a path".into()),
        },
        Some("rename") => match (
            request.get("from").and_then(Value::as_str),
            request.get("to").and_then(Value::as_str),
        ) {
            (Some(from), Some(to)) => match std::fs::rename(from, to) {
                Ok(()) => json!({"id": id, "ok": true}),
                Err(e) => fail(e.to_string()),
            },
            _ => fail("rename needs from and to".into()),
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
        Some("shell") => match request.get("command").and_then(Value::as_str) {
            // One-shot `sh -c` as the session user — the workflow shell task type.
            Some(command) => match std::process::Command::new("sh")
                .args(["-c", command])
                .output()
            {
                Ok(out) => {
                    let mut stdout = String::from_utf8_lossy(&out.stdout).into_owned();
                    stdout.truncate(MAX_RESULT_BYTES);
                    let mut stderr = String::from_utf8_lossy(&out.stderr).into_owned();
                    stderr.truncate(MAX_READ_BYTES);
                    json!({
                        "id": id,
                        "ok": out.status.success(),
                        "stdout": stdout,
                        "stderr": stderr,
                        "exit_code": out.status.code(),
                    })
                }
                Err(e) => fail(format!("cannot run shell: {e}")),
            },
            None => fail("shell needs a command string".into()),
        },
        Some("git") => {
            let args: Vec<String> = request
                .get("args")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            run_git(&id, &args, request.get("cwd").and_then(Value::as_str))
        }
        other => fail(format!(
            "unknown op {other:?} (proto 1: ping/read/write/list/browse/mkdir/delete/\
             rename/sql/python/r/shell/git)"
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
    fn base64_round_trips_common_inputs() {
        assert_eq!(b64_decode("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(b64_decode("").unwrap(), b"");
        assert_eq!(b64_decode("YQ==").unwrap(), b"a");
        // whitespace ignored (MIME-style wrapping)
        assert_eq!(b64_decode("aGVs\nbG8=").unwrap(), b"hello");
        assert!(b64_decode("not base64!").is_none());
    }

    #[test]
    fn git_subcommands_are_whitelisted() {
        let denied = run_git(
            &Value::Null,
            &["daemon".to_string(), "--export-all".to_string()],
            None,
        );
        assert_eq!(denied["ok"], false);
        assert!(denied["error"].as_str().unwrap().contains("not allowed"));
        let empty = run_git(&Value::Null, &[], None);
        assert_eq!(empty["ok"], false);
    }

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
