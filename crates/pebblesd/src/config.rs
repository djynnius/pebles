//! Role bootstrap (REQ-03): the role comes from `PEBBLES_ROLE` on first boot and is
//! then sticky in the config volume. Converting a container between roles means
//! re-running setup, not editing env vars — a mismatch between the sticky file and the
//! env is an error, not a silent re-role.

use anyhow::{bail, Context};
use pebbles_api::Role;
use std::path::{Path, PathBuf};

const ROLE_FILE: &str = "role";

#[derive(Debug)]
pub struct Config {
    pub role: Role,
    pub config_dir: PathBuf,
}

impl Config {
    pub fn load() -> anyhow::Result<Self> {
        let config_dir = PathBuf::from(
            std::env::var("PEBBLES_CONFIG").unwrap_or_else(|_| "/var/lib/pebbles".to_string()),
        );
        let role = resolve_role(&config_dir, std::env::var("PEBBLES_ROLE").ok().as_deref())?;
        Ok(Self { role, config_dir })
    }

    pub fn socket_path(&self) -> PathBuf {
        std::env::var("PEBBLES_SOCKET")
            .map(PathBuf::from)
            .unwrap_or_else(|_| self.config_dir.join("pebblesd.sock"))
    }
}

fn resolve_role(config_dir: &Path, env_role: Option<&str>) -> anyhow::Result<Role> {
    std::fs::create_dir_all(config_dir)
        .with_context(|| format!("creating config volume at {}", config_dir.display()))?;
    let role_file = config_dir.join(ROLE_FILE);

    let sticky = match std::fs::read_to_string(&role_file) {
        Ok(s) => Some(s.trim().parse::<Role>().map_err(anyhow::Error::msg)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e).context("reading sticky role file"),
    };
    let from_env = env_role
        .map(|s| s.parse::<Role>().map_err(anyhow::Error::msg))
        .transpose()?;

    match (sticky, from_env) {
        (Some(sticky), Some(env)) if sticky != env => bail!(
            "this container is already set up as \"{sticky}\" but PEBBLES_ROLE=\"{env}\"; \
             converting a container between roles means re-running setup with a fresh \
             config volume, not changing the env var"
        ),
        (Some(sticky), _) => Ok(sticky),
        (None, Some(env)) => {
            std::fs::write(&role_file, format!("{env}\n")).context("persisting role")?;
            Ok(env)
        }
        (None, None) => bail!(
            "no role configured: set PEBBLES_ROLE=main or PEBBLES_ROLE=engine \
             (the interactive setup wizard lands in M0.2)"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_boot_persists_the_role_and_restarts_keep_it() {
        let dir = tempfile::tempdir().unwrap();
        let role = resolve_role(dir.path(), Some("main")).unwrap();
        assert_eq!(role, Role::Main);
        // Restart without the env var: sticky role wins.
        assert_eq!(resolve_role(dir.path(), None).unwrap(), Role::Main);
    }

    #[test]
    fn conflicting_env_role_is_an_error_not_a_silent_rerole() {
        let dir = tempfile::tempdir().unwrap();
        resolve_role(dir.path(), Some("engine")).unwrap();
        let err = resolve_role(dir.path(), Some("main")).unwrap_err();
        assert!(err.to_string().contains("already set up"));
    }

    #[test]
    fn missing_role_on_first_boot_is_a_loud_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(resolve_role(dir.path(), None).is_err());
    }
}
