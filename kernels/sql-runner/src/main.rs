//! The SQL session kernel.
//!
//! `pebblesd`'s session broker forks this binary with setuid/setgid to the requesting
//! user, cwd `/workspace` (their bind-mounted home). It opens DuckDB with the DuckLake
//! catalog and the session's `memory_limit`, then speaks a line protocol on stdio.
//!
//! Kernels live outside `crates/` and `web/` on purpose: they run *as end users* on
//! engines, and nothing in the web tier may ever execute here.
//!
//! M0.1: protocol handshake stub. DuckDB wiring lands in M0.4/M0.5 with vendored
//! extensions (no runtime INSTALL — NFR-03).

fn main() {
    let hello = serde_json::json!({
        "kernel": "sql-runner",
        "proto": 0,
        "version": env!("CARGO_PKG_VERSION"),
        "status": "stub",
    });
    println!("{hello}");
}
