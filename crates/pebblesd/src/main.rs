//! `pebblesd` — the Pebbles daemon.
//!
//! Runs as PID 1 in the container (symlinked `/sbin/init` for Incus), supervises every
//! other service (Postgres and gunicorn on `main`), and exposes the privileged local
//! API on a unix socket. The Flask tier is a client of that socket and nothing else
//! (NFR-01): the socket is root-owned with group `pebbles`, mode 0660.

mod admins;
mod api;
mod backups;
mod catalog;
mod cluster;
mod config;
mod jobs;
mod migrations;
mod nkoyo;
mod services;
mod supervisor;
mod tls;
mod wizard;

/// The inter-host cluster API port (TLS + bearer, NFR-02; fingerprint-pinned).
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
    // As the init of a system container (Incus), pebblesd starts with NO
    // environment at all — establish the PATH every PATH-relative spawn
    // (groupadd, psql, …) depends on. Docker/Podman inject one; Incus doesn't.
    if std::env::var_os("PATH").is_none() {
        std::env::set_var(
            "PATH",
            "/opt/conda/envs/pebbles/bin:/opt/conda/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        );
    }
    // Same env-stripping story: Incus gives its init NO locale, so the whole
    // supervised tree would run in the C (ASCII) locale — Postgres initdb creates a
    // SQL_ASCII cluster and Python (Airflow) treats non-ASCII as an error. Restore a
    // UTF-8 locale (only if the runtime didn't set one; Docker/Podman may). C.UTF-8
    // is always compiled into glibc, so it needs no locale-gen.
    for key in ["LANG", "LC_ALL"] {
        if std::env::var_os(key).is_none() {
            std::env::set_var(key, "C.UTF-8");
        }
    }
    if std::env::var_os("PYTHONUTF8").is_none() {
        std::env::set_var("PYTHONUTF8", "1");
    }
    tracing_subscriber::fmt().with_target(false).init();
    // The process-level rustls provider MUST be pinned before any TLS config
    // is built: reqwest's rustls-tls pulls aws-lc-rs into the graph alongside
    // our ring feature, and with two candidates rustls refuses to guess —
    // panicking at the first handshake. Ring, explicitly, everywhere.
    if rustls::crypto::ring::default_provider()
        .install_default()
        .is_err()
    {
        tracing::debug!("rustls provider already installed");
    }
    #[cfg(target_os = "linux")]
    ensure_init_mounts();
    #[cfg(target_os = "linux")]
    tokio::spawn(reap_orphans());

    let cfg = config::Config::load(wizard::prompt_role)?;
    tracing::info!(role = %cfg.role, config = %cfg.config_dir.display(), "pebblesd starting");

    // Same volume, fresh image (REQ-09): recreate persisted accounts before
    // anything can reference them.
    match pebbles_identity::host::restore_users(&cfg.config_dir) {
        Ok(0) => {}
        Ok(n) => tracing::info!(restored = n, "restored persisted UNIX accounts"),
        Err(err) => tracing::error!(%err, "restoring persisted accounts failed"),
    }
    if cfg.role == pebbles_api::Role::Main {
        // Who administers this install: the `admins` group (never empty once
        // any user exists — see admins.rs).
        admins::ensure_admins(&cfg.config_dir);
    }

    let socket_path = cfg.socket_path();
    let listener = bind_api_socket(&socket_path)?;
    tracing::info!(socket = %socket_path.display(), "privileged API listening");

    let sup = supervisor::Supervisor::start(services::for_role(&cfg));
    if cfg.role == pebbles_api::Role::Main {
        tokio::spawn(migrations::run(cfg.config_dir.clone()));
        // REQ-50: daily catalog dump + lake manifest, with retention.
        tokio::spawn(backups::scheduled_loop(cfg.config_dir.clone()));
    }
    let clu = cluster::Cluster::load(&cfg.config_dir);
    if cfg.role == pebbles_api::Role::Main {
        // REQ-22: probe registered engines every 10s; flag lost ones.
        tokio::spawn(cluster::health_loop(clu.clone()));
    }

    // Cluster TLS identity (NFR-02): sticky self-signed cert, peers pin its
    // fingerprint. The cluster port serves HTTPS only.
    let (cert_pem, key_pem) = tls::ensure_cert(&cfg.config_dir)?;
    let cluster_cert_fp = tls::fingerprint_pem(&cert_pem);
    let state = session_state(&cfg, clu.clone(), cluster_cert_fp.clone());

    // Inter-host cluster API: registration inbound on the main, session serving
    // inbound on engines (implementation plan §9b M1.1).
    let cluster_addr: std::net::SocketAddr = format!("0.0.0.0:{}", cluster_port()).parse()?;
    let tls_config = tls::server_config(cert_pem, key_pem).await?;
    tracing::info!(addr = %cluster_addr, fp = %cluster_cert_fp.as_deref().unwrap_or("?"),
        "cluster API listening (TLS)");
    let cluster_router = api::cluster_router(cfg.role, state.clone());
    tokio::spawn(async move {
        if let Err(err) = axum_server::bind_rustls(cluster_addr, tls_config)
            .serve(cluster_router.into_make_service())
            .await
        {
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
        _ = halt_signal() => tracing::info!("SIGPWR (init halt)"),
        _ = tokio::signal::ctrl_c() => tracing::info!("interrupt"),
    }
    sup.shutdown().await;
    Ok(())
}

/// Mounts that are the INIT's job. Docker/Podman mount a tmpfs on /dev/shm before
/// our process starts; Incus/LXC do not — autodev populates /dev with device nodes
/// only and leaves /dev/shm to the init system (systemd images mount it themselves).
/// Without it, glibc shm_open/sem_open fail, which kills Python `multiprocessing`
/// — concretely, Airflow's LocalExecutor scheduler crash-loops at startup and no
/// workflow ever triggers, while everything else (Postgres falls back to sysv shm
/// at initdb probe time) appears healthy.
///
/// /run is the same story: Podman gives containers a tmpfs there, Incus leaves it
/// to the init — and a rootfs-backed /run keeps stale state (postgres socket files,
/// pid files) across unclean restarts. Docker neither mounts it nor grants
/// CAP_SYS_ADMIN, so the attempt fails with EPERM there — expected, and harmless:
/// that is the behavior Docker deployments have always had.
///
/// Deliberately NOT mounted: /tmp (tmpfs would put DuckDB spill files in RAM — a
/// data platform wants them on disk), /dev/pts and /proc and /sys (Incus mounts
/// all three for every system container, exactly like Docker/Podman do).
#[cfg(target_os = "linux")]
fn ensure_init_mounts() {
    if std::process::id() != 1 {
        return; // not the init — whoever booted us owns the mount table
    }
    let mounts = std::fs::read_to_string("/proc/self/mounts").unwrap_or_default();
    let mounted = |target: &str| {
        mounts
            .lines()
            .any(|l| l.split_whitespace().nth(1) == Some(target))
    };
    if !mounted("/dev/shm") {
        match mount_tmpfs("/dev/shm", "mode=1777") {
            Ok(()) => tracing::info!("mounted tmpfs on /dev/shm (init duty on Incus/LXC)"),
            Err(err) => tracing::error!(
                %err,
                "mounting /dev/shm failed; Python multiprocessing (Airflow) will break"
            ),
        }
    }
    if !mounted("/run") {
        match mount_tmpfs("/run", "mode=755") {
            Ok(()) => tracing::info!("mounted tmpfs on /run (init duty on Incus/LXC)"),
            Err(err) if err.raw_os_error() == Some(libc::EPERM) => {
                tracing::info!("runtime denies mount(2); keeping the image's /run (Docker)")
            }
            Err(err) => tracing::error!(%err, "mounting tmpfs on /run failed"),
        }
    }
}

#[cfg(target_os = "linux")]
fn mount_tmpfs(target: &str, options: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(target)?;
    let src = std::ffi::CString::new("tmpfs").expect("cstr");
    let target = std::ffi::CString::new(target).expect("cstr");
    let fstype = std::ffi::CString::new("tmpfs").expect("cstr");
    let data = std::ffi::CString::new(options).expect("cstr");
    // SAFETY: plain mount(2) with valid, NUL-terminated arguments.
    let rc = unsafe {
        libc::mount(
            src.as_ptr(),
            target.as_ptr(),
            fstype.as_ptr(),
            libc::MS_NOSUID | libc::MS_NODEV,
            data.as_ptr() as *const libc::c_void,
        )
    };
    if rc == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// PID-1 duty: reap orphaned zombies. Tokio reaps pebblesd's OWN children
/// (supervised services, session kernels, CLI helpers) within milliseconds of
/// SIGCHLD — but as init, pebblesd also inherits every orphaned descendant: a
/// SIGKILLed sshd's session shells, a crashed Airflow scheduler's LocalExecutor
/// workers, a dead postmaster's backends. Nothing ever waits on those, so they
/// would sit in the process table as zombies for the container's lifetime.
///
/// A naive `waitpid(-1)` loop is WRONG here: it steals exit notifications from
/// tokio::process and std::process (their own waitpid gets ECHILD and the exit
/// status is lost). Instead: scan /proc for zombies whose parent is pid 1 and
/// reap a pid only after it has stayed zombie — same pid AND same starttime —
/// across two consecutive sweeps. Our in-process reapers collect their children
/// promptly, so anything zombie for a full sweep interval is an orphan nobody
/// else will ever wait on.
#[cfg(target_os = "linux")]
async fn reap_orphans() {
    if std::process::id() != 1 {
        return; // not the init — orphans don't reparent to us
    }
    let mut pending: std::collections::HashSet<(u32, u64)> = std::collections::HashSet::new();
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        let current = zombie_orphans();
        for &(pid, starttime) in pending.intersection(&current) {
            // Re-check right before reaping: the (pid, starttime) pair must still
            // be a zombie child of ours — closes the already-tiny window where a
            // slow in-process reaper caught up and the pid got recycled.
            if zombie_stat(pid) != Some((b'Z', 1, starttime)) {
                continue;
            }
            let mut status: libc::c_int = 0;
            // SAFETY: WNOHANG waitpid on a specific pid; never blocks, and a pid
            // that is no longer our zombie child just returns 0/ECHILD.
            let rc = unsafe { libc::waitpid(pid as i32, &mut status, libc::WNOHANG) };
            if rc == pid as i32 {
                tracing::info!(pid, "reaped orphaned zombie (init duty)");
            }
        }
        pending = current;
    }
}

/// All current zombies that have been reparented to us: (pid, starttime) pairs —
/// starttime disambiguates pid reuse across sweeps.
#[cfg(target_os = "linux")]
fn zombie_orphans() -> std::collections::HashSet<(u32, u64)> {
    let mut set = std::collections::HashSet::new();
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return set;
    };
    for entry in entries.flatten() {
        let Some(pid) = entry.file_name().to_str().and_then(|s| s.parse().ok()) else {
            continue;
        };
        if let Some((b'Z', 1, starttime)) = zombie_stat(pid) {
            set.insert((pid, starttime));
        }
    }
    set
}

#[cfg(target_os = "linux")]
fn zombie_stat(pid: u32) -> Option<(u8, i32, u64)> {
    stat_fields(&std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?)
}

/// (state, ppid, starttime) from /proc/<pid>/stat content. The comm field may
/// itself contain spaces and parentheses, so parse from the LAST ')'.
#[cfg(any(target_os = "linux", test))]
fn stat_fields(stat: &str) -> Option<(u8, i32, u64)> {
    let rest = stat.rsplit_once(')')?.1;
    let mut fields = rest.split_whitespace();
    let state = *fields.next()?.as_bytes().first()?; // field 3
    let ppid = fields.next()?.parse().ok()?; // field 4
    let starttime = fields.nth(17)?.parse().ok()?; // field 22
    Some((state, ppid, starttime))
}

/// LXC/Incus ask a system container's init to shut down with SIGPWR (the
/// convention systemd honors). An init that ignores it hangs `incus restart`.
async fn halt_signal() {
    #[cfg(target_os = "linux")]
    {
        if let Ok(mut sigpwr) = signal(SignalKind::from_raw(libc::SIGPWR)) {
            sigpwr.recv().await;
            return;
        }
    }
    std::future::pending::<()>().await
}

/// Session serving on this container: the main doubles as an engine by default
/// (REQ-04, `PEBBLES_SERVE_SESSIONS=false` turns it off); engine-role containers
/// serve sessions unconditionally — that is their job.
fn session_state(
    cfg: &config::Config,
    clu: std::sync::Arc<cluster::Cluster>,
    cluster_cert_fp: Option<String>,
) -> api::AppState {
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
                engine_memory_bytes: env_u64(
                    "PEBBLES_ENGINE_MEMORY_BYTES",
                    default_engine_memory(),
                ),
                max_sessions: env_u64("PEBBLES_MAX_SESSIONS", 10) as usize,
                idle_timeout: std::time::Duration::from_secs(env_u64(
                    "PEBBLES_SESSION_IDLE_SECS",
                    1800,
                )),
                // Per-engine toggle (REQ-18) + the drain wait alert (REQ-19).
                allow_dedicated: std::env::var("PEBBLES_ALLOW_DEDICATED").as_deref() != Ok("false"),
                drain_notify: std::time::Duration::from_secs(env_u64(
                    "PEBBLES_DRAIN_NOTIFY_SECS",
                    900,
                )),
            },
        ))
    };
    api::AppState {
        broker,
        default_session_memory,
        config_dir: cfg.config_dir.clone(),
        cluster: clu,
        cluster_cert_fp,
    }
}

#[cfg(test)]
mod tests {
    use super::stat_fields;

    // Real-shaped /proc/<pid>/stat line: pid (comm) state ppid … starttime(22) …
    const ZOMBIE: &str = "742 (airflow worker) Z 1 740 740 0 -1 4227116 0 0 0 0 1 2 3 4 \
                          20 0 1 0 98765 0 0 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 1 0 0 0 0 0";

    #[test]
    fn stat_parser_reads_state_ppid_and_starttime() {
        assert_eq!(stat_fields(ZOMBIE), Some((b'Z', 1, 98765)));
    }

    #[test]
    fn stat_parser_survives_hostile_comm_names() {
        // comm may contain spaces AND parentheses; only the LAST ')' ends it.
        let stat = "99 (a) evil (comm)) R 42 99 99 0 -1 0 0 0 0 0 0 0 0 0 \
                    20 0 1 0 12345 0 0 0";
        assert_eq!(stat_fields(stat), Some((b'R', 42, 12345)));
    }

    #[test]
    fn stat_parser_rejects_truncated_lines() {
        assert_eq!(stat_fields("742 (x) Z 1 740"), None);
        assert_eq!(stat_fields(""), None);
    }
}

/// The session budget when PEBBLES_ENGINE_MEMORY_BYTES isn't set: 75% of the
/// memory this container may actually use — the cgroup limit when one is set
/// (Docker `--memory`, Incus `limits.memory`), else host RAM — leaving headroom
/// for Postgres, Airflow and the web tier. Never below 1 GiB. (It used to be a
/// flat 2 GiB, which on an 8 GB box admitted only four 512 MB sessions.)
fn default_engine_memory() -> u64 {
    const GIB: u64 = 1024 * 1024 * 1024;
    let cgroup = std::fs::read_to_string("/sys/fs/cgroup/memory.max")
        .ok()
        .or_else(|| std::fs::read_to_string("/sys/fs/cgroup/memory/memory.limit_in_bytes").ok())
        .and_then(|s| s.trim().parse::<u64>().ok())
        // "max" (v2) doesn't parse; v1's "unlimited" is a huge sentinel.
        .filter(|&b| b < (1u64 << 60));
    let host = std::fs::read_to_string("/proc/meminfo").ok().and_then(|m| {
        m.lines()
            .find(|l| l.starts_with("MemTotal:"))?
            .split_whitespace()
            .nth(1)?
            .parse::<u64>()
            .ok()
            .map(|kb| kb * 1024)
    });
    let total = match (cgroup, host) {
        (Some(c), Some(h)) => c.min(h),
        (Some(c), None) => c,
        (None, Some(h)) => h,
        (None, None) => 4 * GIB,
    };
    (total / 4 * 3).max(GIB)
}
