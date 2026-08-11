//! Schema versioning and the upgrade path (REQ-09): the config volume carries a
//! schema version; when a newer image boots on an older volume, a pre-migration
//! Postgres backup is taken (non-optional) before any migration steps run. The
//! nightly upgrade test exercises this end to end.

use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};

/// Bump this when a release needs catalog migrations; steps go in `apply_steps`.
pub const SCHEMA_VERSION: u32 = 1;

const PG_SOCKET: &str = "/run/postgresql/.s.PGSQL.5432";

pub async fn run(config_dir: PathBuf) {
    let vfile = config_dir.join("schema-version");
    let stored: Option<u32> = std::fs::read_to_string(&vfile)
        .ok()
        .and_then(|s| s.trim().parse().ok());

    match stored {
        None => {
            // Fresh install: stamp the current version, nothing to migrate.
            if let Err(err) = std::fs::write(&vfile, format!("{SCHEMA_VERSION}\n")) {
                tracing::error!(%err, "cannot stamp schema version");
            } else {
                tracing::info!(version = SCHEMA_VERSION, "schema initialized");
            }
        }
        Some(v) if v == SCHEMA_VERSION => {
            tracing::debug!(version = v, "schema is current");
        }
        Some(v) if v < SCHEMA_VERSION => {
            tracing::info!(from = v, to = SCHEMA_VERSION, "schema migration needed");
            if !wait_for_postgres().await {
                tracing::error!("postgres never came up; migration NOT run");
                return;
            }
            // The backup is non-optional: no backup, no migration (REQ-09).
            match backup(&config_dir, v) {
                Ok(path) => {
                    tracing::info!(backup = %path.display(), "pre-migration backup written")
                }
                Err(err) => {
                    tracing::error!(%err, "pre-migration backup failed; migration NOT run");
                    return;
                }
            }
            apply_steps(v);
            if let Err(err) = std::fs::write(&vfile, format!("{SCHEMA_VERSION}\n")) {
                tracing::error!(%err, "migrated but could not stamp version");
            } else {
                tracing::info!(version = SCHEMA_VERSION, "schema migrated");
            }
        }
        Some(v) => {
            tracing::error!(
                stored = v,
                image = SCHEMA_VERSION,
                "config volume is NEWER than this image — refusing to touch it (downgrade?)"
            );
        }
    }
}

fn apply_steps(_from: u32) {
    // Versioned migration steps land here as releases need them. v1 has none —
    // the machinery (version stamp + mandatory backup) is what M0.6 ships.
}

async fn wait_for_postgres() -> bool {
    for _ in 0..60 {
        if Path::new(PG_SOCKET).exists() {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
    false
}

fn backup(config_dir: &Path, from: u32) -> std::io::Result<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let dir = config_dir.join("backups");
    std::fs::create_dir_all(&dir)?;
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let path = dir.join(format!(
        "pre-migration-v{from}-to-v{SCHEMA_VERSION}-{ts}.sql"
    ));

    let (uid, gid) = pebbles_identity::system_user("postgres")
        .ok_or_else(|| std::io::Error::other("no postgres user"))?;
    let out = std::fs::File::create(&path)?;
    let mut cmd = std::process::Command::new("pg_dumpall");
    cmd.args(["-h", "/run/postgresql"])
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .stdout(out)
        .stderr(std::process::Stdio::piped());
    if uid != unsafe { libc::geteuid() } {
        cmd.uid(uid).gid(gid);
        // The postgres user must be able to read nothing and write nothing here;
        // only the already-open stdout handle crosses the uid boundary.
    }
    let result = cmd.output()?;
    if !result.status.success() {
        let _ = std::fs::remove_file(&path);
        return Err(std::io::Error::other(format!(
            "pg_dumpall failed: {}",
            String::from_utf8_lossy(&result.stderr).trim()
        )));
    }
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    Ok(path)
}
