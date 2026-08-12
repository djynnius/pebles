//! Schema versioning and the upgrade path (REQ-09): the config volume carries a
//! schema version; when a newer image boots on an older volume, a pre-migration
//! Postgres backup is taken (non-optional) before any migration steps run. The
//! nightly upgrade test exercises this end to end.

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
    // Shared dump machinery (backups.rs, REQ-50); the label keeps the
    // pre-migration naming that `backups::prune` deliberately never touches.
    crate::backups::dump_catalog(
        config_dir,
        &format!("pre-migration-v{from}-to-v{SCHEMA_VERSION}"),
    )
}
