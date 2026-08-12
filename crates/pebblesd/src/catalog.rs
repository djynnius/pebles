//! Catalog provisioning (REQ-24/25): a Pebbles catalog is a DuckLake catalog — a
//! Postgres database (`ducklake_<name>`) holding the metadata plus a data directory
//! of Parquet files under the lake root. Sessions attach with the DuckLake
//! extension, peer-authenticated to Postgres as their own uid, so the owner's
//! Postgres role must exist and own the database.
//!
//! All Postgres administration shells out to `psql` running AS the postgres user
//! (peer auth over the local socket) — pebblesd never embeds a database password.

use pebbles_identity::{IdentityError, ProvisionedUser};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CatalogError {
    #[error("invalid catalog name {0:?}: must match [a-z][a-z0-9_]{{0,30}}")]
    InvalidName(String),
    #[error("catalog {0:?} already exists")]
    Exists(String),
    #[error("postgres is not available on this container")]
    NoPostgres,
    #[error("psql failed: {0}")]
    Psql(String),
    #[error(transparent)]
    Identity(#[from] IdentityError),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CatalogInfo {
    pub name: String,
    pub owner: String,
    pub database: String,
    pub data_path: String,
}

pub fn lake_root() -> PathBuf {
    PathBuf::from(
        std::env::var("PEBBLES_LAKE_ROOT").unwrap_or_else(|_| "/var/lib/pebbles/lake".to_string()),
    )
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 31
        && name.chars().next().is_some_and(|c| c.is_ascii_lowercase())
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// The UI shows this SQL alongside the form (REQ-25): both are the same operation.
pub fn equivalent_sql(name: &str) -> String {
    format!("CREATE CATALOG {name};")
}

pub fn create_catalog(name: &str, owner: &ProvisionedUser) -> Result<CatalogInfo, CatalogError> {
    if !valid_name(name) {
        return Err(CatalogError::InvalidName(name.to_string()));
    }
    let database = format!("ducklake_{name}");
    if list_catalogs()?.iter().any(|c| c.name == name) {
        return Err(CatalogError::Exists(name.to_string()));
    }

    // Data directory: owned by the catalog owner. Group grants arrive in Phase 1.
    let data_dir = lake_root().join(name);
    std::fs::create_dir_all(&data_dir)?;
    std::os::unix::fs::chown(&data_dir, Some(owner.uid), Some(owner.gid))?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&data_dir, std::fs::Permissions::from_mode(0o700))?;

    // Owner's Postgres role (peer auth: UNIX name == role name), then the database.
    psql(&format!(
        "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '{owner_name}') \
         THEN CREATE ROLE \"{owner_name}\" LOGIN; END IF; END $$;",
        owner_name = owner.username
    ))?;
    // M2.5b: the owner may attach this catalog from a remote engine over TCP.
    if let Err(err) = ensure_pg_password(&owner.username) {
        tracing::warn!(user = %owner.username, %err, "pg password sync failed");
    }
    psql(&format!(
        "CREATE DATABASE \"{database}\" OWNER \"{}\";",
        owner.username
    ))?;

    Ok(CatalogInfo {
        name: name.to_string(),
        owner: owner.username.clone(),
        database,
        data_path: data_dir.display().to_string(),
    })
}

pub fn list_catalogs() -> Result<Vec<CatalogInfo>, CatalogError> {
    let out = psql(
        "SELECT d.datname || ':' || r.rolname FROM pg_database d \
         JOIN pg_roles r ON r.oid = d.datdba WHERE d.datname LIKE 'ducklake\\_%' ORDER BY 1;",
    )?;
    Ok(out
        .lines()
        .filter_map(|line| {
            let (db, owner) = line.trim().split_once(':')?;
            let name = db.strip_prefix("ducklake_")?;
            Some(CatalogInfo {
                name: name.to_string(),
                owner: owner.to_string(),
                database: db.to_string(),
                data_path: lake_root().join(name).display().to_string(),
            })
        })
        .collect())
}

/// Grant a team group access to a catalog (REQ-13). Three coordinated moves:
/// filesystem (setgid group dir), database-level (CONNECT), and in-database
/// (schema/table privileges + default privileges for future tables), plus role
/// membership for each current member — new members get wired by `sync_member`.
pub fn grant_catalog(
    catalog: &CatalogInfo,
    group: &pebbles_identity::PebblesGroup,
) -> Result<(), CatalogError> {
    use std::os::unix::fs::PermissionsExt;
    let data_dir = PathBuf::from(&catalog.data_path);
    std::os::unix::fs::chown(&data_dir, None, Some(group.gid))?;
    std::fs::set_permissions(&data_dir, std::fs::Permissions::from_mode(0o2770))?;

    ensure_role(&group.name, false)?;
    psql(&format!(
        "GRANT CONNECT ON DATABASE \"{}\" TO \"{}\";",
        catalog.database, group.name
    ))?;
    psql_in(
        &catalog.database,
        &format!(
            "GRANT USAGE, CREATE ON SCHEMA public TO \"{g}\"; \
             GRANT ALL ON ALL TABLES IN SCHEMA public TO \"{g}\"; \
             GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO \"{g}\"; \
             ALTER DEFAULT PRIVILEGES FOR ROLE \"{o}\" IN SCHEMA public GRANT ALL ON TABLES TO \"{g}\"; \
             ALTER DEFAULT PRIVILEGES FOR ROLE \"{o}\" IN SCHEMA public GRANT ALL ON SEQUENCES TO \"{g}\";",
            g = group.name,
            o = catalog.owner
        ),
    )?;
    for member in &group.members {
        sync_member(&group.name, member)?;
    }
    Ok(())
}

/// Wire one user into a granted group's Postgres role (login role created on
/// demand, then role membership). Called at grant time and on membership adds.
pub fn sync_member(group: &str, username: &str) -> Result<(), CatalogError> {
    ensure_role(username, true)?;
    if let Err(err) = ensure_pg_password(username) {
        tracing::warn!(user = %username, %err, "pg password sync failed (remote attach)");
    }
    psql(&format!("GRANT \"{group}\" TO \"{username}\";"))?;
    Ok(())
}

/// M2.5b: give the user's Postgres role a scram password living ONLY in their
/// own ~/.pgpass (0600) — remote engines' kernels attach the catalog over TCP
/// with it (libpq reads .pgpass automatically), while local sessions keep peer
/// auth over the socket. Idempotent: an existing .pgpass entry is the record
/// that role + file are already in sync.
pub fn ensure_pg_password(username: &str) -> Result<(), CatalogError> {
    use std::os::unix::fs::PermissionsExt;
    let Some(user) = pebbles_identity::host::list_users()
        .ok()
        .and_then(|users| users.into_iter().find(|u| u.username == username))
    else {
        return Ok(()); // not a host account (e.g. dev run) — nothing to wire
    };
    let pgpass = std::path::Path::new(&user.home).join(".pgpass");
    if let Ok(existing) = std::fs::read_to_string(&pgpass) {
        if existing
            .lines()
            .any(|l| l.split(':').nth(3) == Some(username))
        {
            return Ok(());
        }
    }
    let password = crate::cluster::random_hex(24);
    ensure_role(username, true)?;
    psql(&format!("ALTER ROLE \"{username}\" PASSWORD '{password}';"))?;
    let line = format!("*:*:*:{username}:{password}\n");
    let mut content = std::fs::read_to_string(&pgpass).unwrap_or_default();
    content.push_str(&line);
    std::fs::write(&pgpass, content)?;
    std::fs::set_permissions(&pgpass, std::fs::Permissions::from_mode(0o600))?;
    std::os::unix::fs::chown(&pgpass, Some(user.uid), Some(user.gid))?;
    tracing::info!(user = %username, "catalog TCP credential provisioned (~/.pgpass)");
    Ok(())
}

pub(crate) fn ensure_role(name: &str, login: bool) -> Result<(), CatalogError> {
    let kind = if login { "LOGIN" } else { "NOLOGIN" };
    psql(&format!(
        "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '{name}') \
         THEN CREATE ROLE \"{name}\" {kind}; END IF; END $$;"
    ))?;
    Ok(())
}

/// Run one statement as the postgres superuser over the local socket.
pub(crate) fn psql(sql: &str) -> Result<String, CatalogError> {
    psql_in("postgres", sql)
}

pub(crate) fn psql_in(db: &str, sql: &str) -> Result<String, CatalogError> {
    let (uid, gid) = pebbles_identity::system_user("postgres").ok_or(CatalogError::NoPostgres)?;
    let mut cmd = std::process::Command::new("psql");
    cmd.args([
        "-h",
        "/run/postgresql",
        "-d",
        db,
        "-v",
        "ON_ERROR_STOP=1",
        "-tA",
        "-c",
        sql,
    ]);
    if uid != unsafe { libc::geteuid() } {
        cmd.uid(uid).gid(gid);
    }
    let out = cmd
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .output()
        .map_err(|e| CatalogError::Psql(e.to_string()))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(CatalogError::Psql(
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_names_are_conservative() {
        assert!(valid_name("claims"));
        assert!(valid_name("claims_2026"));
        for bad in ["", "Claims", "2claims", "cl-aims", "a".repeat(32).as_str()] {
            assert!(!valid_name(bad), "{bad:?} should be invalid");
        }
    }

    #[test]
    fn the_form_and_the_sql_are_the_same_operation() {
        assert_eq!(equivalent_sql("claims"), "CREATE CATALOG claims;");
    }
}
