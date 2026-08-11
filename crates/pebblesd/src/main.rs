//! `pebblesd` — the Pebbles daemon.
//!
//! Runs as PID 1 in the container (symlinked `/sbin/init` for Incus), supervises every
//! other service (Postgres and gunicorn on `main`), and exposes the privileged local
//! API on a unix socket. The Flask tier is a client of that socket and nothing else
//! (NFR-01): the socket is root-owned with group `pebbles`, mode 0660.

mod config;
mod services;
mod supervisor;
mod wizard;

use axum::{routing::get, Json, Router};
use pebbles_api::{Health, Role, VersionInfo};
use tokio::net::UnixListener;
use tokio::signal::unix::{signal, SignalKind};

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

fn bind_api_socket(path: &std::path::Path) -> anyhow::Result<UnixListener> {
    use std::os::unix::fs::PermissionsExt;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    let listener = UnixListener::bind(path)?;
    // Access control: group `pebbles` (the web user's group) may connect; nobody else.
    // Outside the image (dev loop) the group doesn't exist and owner-only is correct.
    match pebbles_identity::system_group("pebbles") {
        Some(gid) => {
            std::os::unix::fs::chown(path, None, Some(gid))?;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o660))?;
        }
        None => std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?,
    }
    Ok(listener)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_target(false).init();

    let cfg = config::Config::load(wizard::prompt_role)?;
    tracing::info!(role = %cfg.role, config = %cfg.config_dir.display(), "pebblesd starting");

    let socket_path = cfg.socket_path();
    let listener = bind_api_socket(&socket_path)?;
    tracing::info!(socket = %socket_path.display(), "privileged API listening");

    let sup = supervisor::Supervisor::start(services::for_role(&cfg));

    let mut sigterm = signal(SignalKind::terminate())?;
    tokio::select! {
        r = axum::serve(listener, app(cfg.role)) => r?,
        _ = sigterm.recv() => tracing::info!("SIGTERM"),
        _ = tokio::signal::ctrl_c() => tracing::info!("interrupt"),
    }
    sup.shutdown().await;
    Ok(())
}
