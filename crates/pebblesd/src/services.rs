//! Which services a role runs (implementation plan §2.1: pebblesd supervises
//! everything). Paths are probed at startup: in the image they exist; in the native
//! dev loop they don't, and each missing service is skipped with a warning so
//! `cargo run -p pebblesd` stays useful on a laptop.

use crate::config::Config;
use crate::supervisor::{Exec, ServiceSpec};
use pebbles_api::Role;
use std::path::{Path, PathBuf};

const WEB_ROOT: &str = "/opt/pebbles/web";
const WEB_USER: &str = "pebbles-web";
const PG_SOCKET_DIR: &str = "/run/postgresql";

pub fn for_role(cfg: &Config) -> Vec<ServiceSpec> {
    let mut services = Vec::new();
    // As PID 1 of a system container (Incus), pebblesd IS the init: nothing else
    // will configure the network. Docker/Podman pre-configure it and the service
    // detects that and stands down.
    if let Some(spec) = network() {
        services.push(spec);
    }
    match cfg.role {
        Role::Main => {
            match postgres(cfg) {
                Some(spec) => services.push(spec),
                None => tracing::warn!("postgres not available; catalog services disabled"),
            }
            match gunicorn(cfg) {
                Some(spec) => services.push(spec),
                None => tracing::warn!("web tier not available; UI disabled"),
            }
            services.extend(airflow(cfg));
        }
        // Engine-role services (session broker serving a remote main) land in Phase 1.
        Role::Engine => {}
    }
    services
}

/// Hidden Airflow (REQ-38): api-server (localhost only), scheduler, and
/// dag-processor, all as the unprivileged airflow user in its own venv. Users
/// never see it — the Jobs UI is the only face. Postgres provisioning happens in
/// pre-steps that wait for the socket, because postgres itself is still booting
/// when these specs are constructed.
fn airflow(cfg: &Config) -> Vec<ServiceSpec> {
    let Some((uid, gid)) = pebbles_identity::system_user(crate::jobs::AIRFLOW_USER) else {
        return Vec::new();
    };
    let Some((pg_uid, pg_gid)) = pebbles_identity::system_user("postgres") else {
        return Vec::new();
    };
    let envs = match crate::jobs::prepare_fs(&cfg.config_dir) {
        Ok(envs) => envs,
        Err(crate::jobs::JobsError::NoAirflow) => return Vec::new(),
        Err(err) => {
            tracing::error!(%err, "airflow provisioning failed; jobs disabled");
            return Vec::new();
        }
    };
    let sh = |script: &str, run_as: Option<(u32, u32)>| Exec {
        program: "sh".into(),
        args: vec!["-c".into(), script.to_string()],
        envs: vec![("PATH".into(), "/usr/local/bin:/usr/bin:/bin".into())],
        run_as,
    };
    let exec = |args: &[&str]| Exec {
        program: crate::jobs::AIRFLOW_BIN.into(),
        args: args.iter().map(|s| s.to_string()).collect(),
        envs: envs.clone(),
        run_as: Some((uid, gid)),
    };
    let bootstrap = || {
        vec![
            sh(crate::jobs::WAIT_PG_SH, None),
            sh(crate::jobs::PROVISION_SH, Some((pg_uid, pg_gid))),
        ]
    };
    let mut with_migrate = bootstrap();
    with_migrate.push(exec(&["db", "migrate"]));
    vec![
        ServiceSpec {
            name: "airflow-api".into(),
            pre: with_migrate,
            exec: exec(&[
                "api-server",
                "--host",
                "127.0.0.1",
                "--port",
                &crate::jobs::API_PORT.to_string(),
            ]),
        },
        // Scheduler and dag-processor crash-restart with backoff until the
        // migrated schema appears; the supervisor absorbs that window.
        ServiceSpec {
            name: "airflow-scheduler".into(),
            pre: bootstrap(),
            exec: exec(&["scheduler"]),
        },
        ServiceSpec {
            name: "airflow-dag-processor".into(),
            pre: bootstrap(),
            exec: exec(&["dag-processor"]),
        },
    ]
}

/// Loopback + DHCP on eth0, via busybox, only when the runtime didn't already
/// configure the interface (no eth0 routes = we're the init that must do it).
fn network() -> Option<ServiceSpec> {
    let busybox = Path::new("/bin/busybox");
    if !Path::new("/sys/class/net/eth0").exists() || !busybox.exists() {
        return None;
    }
    let routes = std::fs::read_to_string("/proc/net/route").unwrap_or_default();
    if routes.lines().skip(1).any(|l| l.starts_with("eth0")) {
        return None; // Docker/Podman already configured networking
    }
    let bb = |args: &[&str]| Exec {
        program: busybox.to_path_buf(),
        args: args.iter().map(|s| s.to_string()).collect(),
        envs: vec![],
        run_as: None,
    };
    Some(ServiceSpec {
        name: "network".into(),
        pre: vec![
            bb(&["ip", "link", "set", "lo", "up"]),
            bb(&["ip", "link", "set", "eth0", "up"]),
        ],
        exec: bb(&[
            "udhcpc",
            "-f",
            "-i",
            "eth0",
            "-s",
            "/opt/pebbles/scripts/udhcpc.sh",
        ]),
    })
}

/// Postgres for the DuckLake catalog (spec §3 Storage). Unix socket only — nothing
/// outside the container ever talks to it. Data lives in the config volume so
/// "upgrade = pull new image, same volume" (REQ-09) covers the catalog.
fn postgres(cfg: &Config) -> Option<ServiceSpec> {
    let bindir = pg_bindir()?;
    let (uid, gid) = pebbles_identity::system_user("postgres")?;
    let datadir = cfg.config_dir.join("postgres");

    for (dir, mode) in [(&datadir, 0o700), (&PathBuf::from(PG_SOCKET_DIR), 0o755)] {
        if let Err(err) = prepare_dir(dir, uid, gid, mode) {
            tracing::error!(dir = %dir.display(), %err, "cannot prepare postgres dir");
            return None;
        }
    }

    let pre = if datadir.join("PG_VERSION").exists() {
        vec![]
    } else {
        vec![Exec {
            program: bindir.join("initdb"),
            args: vec![
                "-D".into(),
                datadir.display().to_string(),
                "--auth-local=peer".into(),
                "--auth-host=reject".into(),
            ],
            envs: vec![],
            run_as: Some((uid, gid)),
        }]
    };

    Some(ServiceSpec {
        name: "postgres".into(),
        pre,
        exec: Exec {
            program: bindir.join("postgres"),
            args: vec![
                "-D".into(),
                datadir.display().to_string(),
                "-k".into(),
                PG_SOCKET_DIR.into(),
                "-c".into(),
                "listen_addresses=".into(),
            ],
            envs: vec![],
            run_as: Some((uid, gid)),
        },
    })
}

/// The Flask tier under gunicorn on :8080, always as the unprivileged web user —
/// never root (NFR-01). It reaches pebblesd only through the unix socket.
fn gunicorn(cfg: &Config) -> Option<ServiceSpec> {
    let gunicorn = Path::new(WEB_ROOT).join(".venv/bin/gunicorn");
    if !gunicorn.exists() {
        return None;
    }
    let Some((uid, gid)) = pebbles_identity::system_user(WEB_USER) else {
        tracing::error!("user {WEB_USER} missing; refusing to run the web tier as root (NFR-01)");
        return None;
    };
    let mut envs = vec![(
        "PEBBLES_SOCKET".into(),
        cfg.socket_path().display().to_string(),
    )];
    match ensure_web_secret(cfg) {
        Ok(secret) => envs.push((
            "PEBBLES_WEB_SECRET_FILE".into(),
            secret.display().to_string(),
        )),
        // Without a shared secret, each gunicorn worker would mint its own and
        // session cookies would bounce between workers — better to fail the service.
        Err(err) => {
            tracing::error!(%err, "cannot provision web session secret; UI disabled");
            return None;
        }
    }
    Some(ServiceSpec {
        name: "web".into(),
        pre: vec![],
        exec: Exec {
            program: gunicorn,
            args: vec![
                "--bind".into(),
                "0.0.0.0:8080".into(),
                // Threaded workers: SSE responses hold a connection each (spec risk:
                // "Flask streaming under load"); sync workers would starve at 2.
                "--workers".into(),
                "2".into(),
                "--worker-class".into(),
                "gthread".into(),
                "--threads".into(),
                "8".into(),
                "--chdir".into(),
                WEB_ROOT.into(),
                "pebbles_web:create_app()".into(),
            ],
            envs,
            run_as: Some((uid, gid)),
        },
    })
}

/// Stable Flask session secret in the config volume: root-owned, readable by the
/// `pebbles` group only, survives restarts so logins do too.
fn ensure_web_secret(cfg: &Config) -> std::io::Result<PathBuf> {
    use std::io::Read;
    use std::os::unix::fs::PermissionsExt;
    let path = cfg.config_dir.join("web-secret");
    if !path.exists() {
        let mut bytes = [0u8; 32];
        std::fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
        let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        std::fs::write(&path, hex)?;
    }
    if let Some(gid) = pebbles_identity::system_group("pebbles") {
        std::os::unix::fs::chown(&path, Some(0), Some(gid))?;
    }
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640))?;
    Ok(path)
}

/// Highest-versioned Debian postgres bindir (`/usr/lib/postgresql/<N>/bin`).
fn pg_bindir() -> Option<PathBuf> {
    let base = Path::new("/usr/lib/postgresql");
    let version = std::fs::read_dir(base)
        .ok()?
        .filter_map(|e| e.ok()?.file_name().into_string().ok()?.parse::<u32>().ok())
        .max()?;
    let bindir = base.join(version.to_string()).join("bin");
    bindir.join("postgres").exists().then_some(bindir)
}

fn prepare_dir(dir: &Path, uid: u32, gid: u32, mode: u32) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(dir)?;
    std::os::unix::fs::chown(dir, Some(uid), Some(gid))?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(mode))
}
