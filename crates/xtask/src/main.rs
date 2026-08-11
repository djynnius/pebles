//! Repo automation, cargo-xtask style. Tasks:
//!
//! - `api-schema` — print pebblesd's OpenAPI schema as JSON. CI's `api-drift` job
//!   regenerates the Flask client from this and fails on a dirty tree (NFR-01).

use std::process::ExitCode;

fn main() -> ExitCode {
    match std::env::args().nth(1).as_deref() {
        Some("api-schema") => {
            println!("{}", pebbles_api::openapi_json());
            ExitCode::SUCCESS
        }
        other => {
            eprintln!("unknown task {other:?}\n\nusage: cargo run -p xtask -- api-schema");
            ExitCode::FAILURE
        }
    }
}
