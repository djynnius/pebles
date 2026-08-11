//! `pebblesd` — the Pebbles daemon.
//!
//! Runs as PID 1 in the container (symlinked `/sbin/init` for Incus), supervises every
//! other service (Postgres and gunicorn on `main`), and exposes the privileged local
//! API on a unix socket. The Flask tier is a client of that socket and nothing else
//! (NFR-01): the socket is root-owned with group `pebbles`, mode 0660.

mod api;
mod catalog;
mod cluster;
mod config;
mod migrations;
mod services;
mod supervisor;
mod wizard;

/// The inter-host cluster API port (TCP; plain HTTP + bearer in M1.1, TLS pre-v1.0).
pub fn cluster_port() -> u16 {
    std::env::var("PEBBLES_CLUSTER_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(7443)
}

use tokio::net::UnixListener;
use tokio::signal::unix::{signal, SignalKind};

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

    // Same volume, fresh image (REQ-09): recreate persisted accounts before
    // anything can reference them.
    match pebbles_identity::host::restore_users(&cfg.config_dir) {
        Ok(0) => {}
        Ok(n) => tracing::info!(restored = n, "restored persisted UNIX accounts"),
        Err(err) => tracing::error!(%err, "restoring persisted accounts failed"),
    }

    let socket_path = cfg.socket_path();
    let listener = bind_api_socket(&socket_path)?;
    tracing::info!(socket = %socket_path.display(), "privileged API listening");

    let sup = supervisor::Supervisor::start(services::for_role(&cfg));
    if cfg.role == pebbles_api::Role::Main {
        tokio::spawn(migrations::run(cfg.config_dir.clone()));
    }
    let clu = cluster::Cluster::load(&cfg.config_dir);
    let state = session_state(&cfg, clu.clone());

    // Inter-host cluster API: registration inbound on the main, session serving
    // inbound on engines (implementation plan §9b M1.1).
    let cluster_addr = format!("0.0.0.0:{}", cluster_port());
    let cluster_tcp = tokio::net::TcpListener::bind(&cluster_addr).await?;
    tracing::info!(addr = %cluster_addr, "cluster API listening");
    let cluster_router = api::cluster_router(cfg.role, state.clone());
    tokio::spawn(async move {
        if let Err(err) = axum::serve(cluster_tcp, cluster_router).await {
            tracing::error!(%err, "cluster API server exited");
        }
    });
    if cfg.role == pebbles_api::Role::Engine {
        tokio::spawn(cluster::engine_boot(cfg.config_dir.clone(), clu));
    }

    let mut sigterm = signal(SignalKind::terminate())?;
    tokio::select! {
        r = axum::serve(listener, api::router(cfg.role, state)) => r?,
        _ = sigterm.recv() => tracing::info!("SIGTERM"),
        _ = tokio::signal::ctrl_c() => tracing::info!("interrupt"),
    }
    sup.shutdown().await;
    Ok(())
}

/// Session serving on this container: the main doubles as an engine by default
/// (REQ-04, `PEBBLES_SERVE_SESSIONS=false` turns it off); engine-role containers
/// serve sessions unconditionally — that is their job.
fn session_state(cfg: &config::Config, clu: std::sync::Arc<cluster::Cluster>) -> api::AppState {
    fn env_u64(key: &str, default: u64) -> u64 {
        std::env::var(key)
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(default)
    }
    let default_session_memory = env_u64("PEBBLES_SESSION_MEMORY_BYTES", 512 * 1024 * 1024);

    let serves = cfg.role == pebbles_api::Role::Engine
        || std::env::var("PEBBLES_SERVE_SESSIONS").as_deref() != Ok("false");
    let kernel = std::path::PathBuf::from(
        std::env::var("PEBBLES_KERNEL")
            .unwrap_or_else(|_| "/usr/local/bin/pebbles-sql-runner".to_string()),
    );

    let broker = if !serves {
        None
    } else if !kernel.exists() {
        tracing::warn!(kernel = %kernel.display(), "kernel binary missing; sessions disabled (dev run?)");
        None
    } else {
        Some(pebbles_session::broker::Broker::start(
            pebbles_session::broker::BrokerConfig {
                kernel,
                engine_memory_bytes: env_u64("PEBBLES_ENGINE_MEMORY_BYTES", 2 * 1024 * 1024 * 1024),
                max_sessions: env_u64("PEBBLES_MAX_SESSIONS", 10) as usize,
                idle_timeout: std::time::Duration::from_secs(env_u64(
                    "PEBBLES_SESSION_IDLE_SECS",
                    1800,
                )),
            },
        ))
    };
    api::AppState {
        broker,
        default_session_memory,
        config_dir: cfg.config_dir.clone(),
        cluster: clu,
    }
}
