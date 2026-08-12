//! Scheduled backups (REQ-50). The catalog (Postgres: DuckLake metadata,
//! Airflow, grants) is dumped with `pg_dumpall` into the config volume's
//! `backups/` dir on a daily loop, with retention; every scheduled dump also
//! writes a manifest of the lake's data files (relative path + size) so a
//! restore can verify the lake copy it is paired with. The lake's Parquet
//! files themselves are NOT copied here — they are large and append-mostly,
//! and belong to a filesystem-level procedure (documented in HOWTO.md:
//! rsync/snapshot the lake root alongside the config volume). The
//! pre-migration backup (migrations.rs, REQ-09) shares `dump_catalog`.

use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};

const PG_SOCKET: &str = "/run/postgresql/.s.PGSQL.5432";

fn env_u64(key: &str, default: u64) -> u64 {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn backups_dir(config_dir: &Path) -> PathBuf {
    config_dir.join("backups")
}

/// `pg_dumpall` into `backups/<label>-<ts>.sql` (0600, dir 0700), run as the
/// postgres user with a cleared env — only the already-open stdout handle
/// crosses the uid boundary.
pub fn dump_catalog(config_dir: &Path, label: &str) -> std::io::Result<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let dir = backups_dir(config_dir);
    std::fs::create_dir_all(&dir)?;
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    let path = dir.join(format!("{label}-{}.sql", now()));

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

/// One line per lake data file: `<size>\t<relative path>` — enough to verify
/// a filesystem-level lake copy pairs with this catalog dump.
pub fn write_lake_manifest(
    config_dir: &Path,
    lake_root: &Path,
    ts: u64,
) -> std::io::Result<PathBuf> {
    let path = backups_dir(config_dir).join(format!("scheduled-{ts}.lake-manifest"));
    let mut lines = Vec::new();
    collect_files(lake_root, lake_root, &mut lines);
    lines.sort();
    std::fs::write(&path, lines.join("\n") + "\n")?;
    Ok(path)
}

fn collect_files(root: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_files(root, &path, out);
        } else if let (Ok(meta), Ok(rel)) = (entry.metadata(), path.strip_prefix(root)) {
            out.push(format!("{}\t{}", meta.len(), rel.display()));
        }
    }
}

/// Keep the newest `keep` scheduled backups (dump + manifest pairs); never
/// touches pre-migration backups — those are the upgrade path's safety net.
pub fn prune(config_dir: &Path, keep: usize) {
    let dir = backups_dir(config_dir);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    let mut scheduled: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("scheduled-") && n.ends_with(".sql"))
        })
        .collect();
    scheduled.sort(); // timestamps sort lexically at fixed epoch width
    while scheduled.len() > keep {
        let old = scheduled.remove(0);
        let _ = std::fs::remove_file(&old);
        // the paired manifest goes with its dump
        if let Some(name) = old.file_name().and_then(|n| n.to_str()) {
            let manifest = dir.join(name.replace(".sql", ".lake-manifest"));
            let _ = std::fs::remove_file(manifest);
        }
        tracing::info!(pruned = %old.display(), "old scheduled backup removed");
    }
}

/// The daily loop (main role): dump + manifest + prune. Interval and retention
/// are env-tunable; `PEBBLES_BACKUP_INTERVAL_SECS=0` disables scheduling
/// entirely (the documented manual `pg_dumpall` procedure still applies).
pub async fn scheduled_loop(config_dir: PathBuf) {
    let interval = env_u64("PEBBLES_BACKUP_INTERVAL_SECS", 86_400);
    let keep = env_u64("PEBBLES_BACKUP_KEEP", 7) as usize;
    if interval == 0 {
        tracing::info!("scheduled backups disabled (PEBBLES_BACKUP_INTERVAL_SECS=0)");
        return;
    }
    let lake_root =
        std::env::var("PEBBLES_LAKE_ROOT").unwrap_or_else(|_| "/var/lib/pebbles/lake".to_string());
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(interval)).await;
        if !Path::new(PG_SOCKET).exists() {
            tracing::warn!("scheduled backup skipped: postgres socket absent");
            continue;
        }
        let dir = config_dir.clone();
        let lake = PathBuf::from(&lake_root);
        let result = tokio::task::spawn_blocking(move || {
            let dump = dump_catalog(&dir, "scheduled")?;
            let ts: u64 = dump
                .file_stem()
                .and_then(|s| s.to_str())
                .and_then(|s| s.rsplit('-').next())
                .and_then(|s| s.parse().ok())
                .unwrap_or_else(now);
            let manifest = write_lake_manifest(&dir, &lake, ts)?;
            prune(&dir, keep);
            Ok::<_, std::io::Error>((dump, manifest))
        })
        .await;
        match result {
            Ok(Ok((dump, manifest))) => tracing::info!(
                dump = %dump.display(), manifest = %manifest.display(),
                "scheduled backup written (REQ-50)"
            ),
            Ok(Err(err)) => tracing::error!(%err, "scheduled backup failed"),
            Err(err) => tracing::error!(%err, "scheduled backup task panicked"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prune_keeps_newest_scheduled_and_all_premigration_backups() {
        let dir = tempfile::tempdir().unwrap();
        let backups = backups_dir(dir.path());
        std::fs::create_dir_all(&backups).unwrap();
        for ts in 1000..1005 {
            std::fs::write(backups.join(format!("scheduled-{ts}.sql")), "x").unwrap();
            std::fs::write(backups.join(format!("scheduled-{ts}.lake-manifest")), "x").unwrap();
        }
        std::fs::write(backups.join("pre-migration-v1-to-v2-999.sql"), "x").unwrap();

        prune(dir.path(), 2);

        let names: Vec<String> = std::fs::read_dir(&backups)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        // the two newest scheduled pairs survive
        assert!(names.contains(&"scheduled-1004.sql".to_string()));
        assert!(names.contains(&"scheduled-1003.sql".to_string()));
        assert!(names.contains(&"scheduled-1004.lake-manifest".to_string()));
        // the old ones (and their manifests) are gone
        assert!(!names
            .iter()
            .any(|n| n.contains("1000") || n.contains("1001")));
        // pre-migration backups are never pruned
        assert!(names.contains(&"pre-migration-v1-to-v2-999.sql".to_string()));
    }

    #[test]
    fn lake_manifest_lists_files_with_sizes() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(backups_dir(dir.path())).unwrap();
        let lake = dir.path().join("lake");
        std::fs::create_dir_all(lake.join("claims")).unwrap();
        std::fs::write(lake.join("claims/part-0.parquet"), b"12345").unwrap();

        let manifest = write_lake_manifest(dir.path(), &lake, 42).unwrap();
        let content = std::fs::read_to_string(manifest).unwrap();
        assert_eq!(content, "5\tclaims/part-0.parquet\n");
    }
}
