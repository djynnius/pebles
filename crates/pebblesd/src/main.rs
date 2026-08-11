//! `pebblesd` — the Pebbles daemon.
//!
//! Runs as PID 1 in the container (symlinked `/sbin/init` for Incus), supervises every
//! other service, and exposes the privileged local API on a unix socket. The Flask tier
//! is a client of that socket and nothing else (NFR-01).
//!
//! M0.1 scope: role bootstrap (sticky in the config volume, REQ-03) and a health/version
//! API. The TCP listener exists so smoke tests can probe the container before the web
//! tier owns port 8080 in M0.2; it serves only the same health endpoints.

mod config;

use axum::{routing::get, Json, Router};
use pebbles_api::{Health, Role, VersionInfo};
use tokio::net::{TcpListener, UnixListener};

fn app(role: Role) -> Router {
    Router::new()
        .route(
            "/healthz",
            get(move || async move {
                Json(Health {
                    status: "ok".to_string(),
                    role,
                })
            }),
        )
        .route(
            "/version",
            get(|| async {
                Json(VersionInfo {
                    version: env!("CARGO_PKG_VERSION").to_string(),
                })
            }),
        )
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_target(false).init();

    let cfg = config::Config::load()?;
    tracing::info!(role = %cfg.role, config = %cfg.config_dir.display(), "pebblesd starting");

    let socket_path = cfg.socket_path();
    if socket_path.exists() {
        std::fs::remove_file(&socket_path)?;
    }
    let unix = UnixListener::bind(&socket_path)?;
    tracing::info!(socket = %socket_path.display(), "privileged API listening");

    let http_addr =
        std::env::var("PEBBLES_HTTP_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".to_string());
    let tcp = TcpListener::bind(&http_addr).await?;
    tracing::info!(addr = %http_addr, "health endpoint listening (temporary until M0.2)");

    let unix_srv = axum::serve(unix, app(cfg.role));
    let tcp_srv = axum::serve(tcp, app(cfg.role));

    tokio::select! {
        r = unix_srv => r?,
        r = tcp_srv => r?,
        _ = tokio::signal::ctrl_c() => tracing::info!("shutting down"),
    }
    Ok(())
}
