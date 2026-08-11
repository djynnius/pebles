//! Role bootstrap (REQ-03): the role comes from `PEBBLES_ROLE` on first boot (or the
//! TTY wizard when interactive) and is then sticky in the config volume. Converting a
//! container between roles means re-running setup, not editing env vars — a mismatch
//! between the sticky file and the env is an error, not a silent re-role.

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
    /// `fallback` supplies a role when neither the sticky file nor the env has one
    /// (the TTY wizard in production; a closure in tests).
    pub fn load(fallback: impl FnOnce() -> Option<Role>) -> anyhow::Result<Self> {
        let config_dir = PathBuf::from(
            std::env::var("PEBBLES_CONFIG").unwrap_or_else(|_| "/var/lib/pebbles".to_string()),
        );
        let role = resolve_role(
            &config_dir,
            std::env::var("PEBBLES_ROLE").ok().as_deref(),
            fallback,
        )?;
        Ok(Self { role, config_dir })
    }

    /// The privileged API socket. Lives under /run (not the config volume): it is
    /// ephemeral, and its group ownership — not its location — is the access control.
    pub fn socket_path(&self) -> PathBuf {
        std::env::var("PEBBLES_SOCKET")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("/run/pebbles/pebblesd.sock"))
    }
}

fn resolve_role(
    config_dir: &Path,
    env_role: Option<&str>,
    fallback: impl FnOnce() -> Option<Role>,
) -> anyhow::Result<Role> {
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

    let chosen = match (sticky, from_env) {
        (Some(sticky), Some(env)) if sticky != env => bail!(
            "this container is already set up as \"{sticky}\" but PEBBLES_ROLE=\"{env}\"; \
             converting a container between roles means re-running setup with a fresh \
             config volume, not changing the env var"
        ),
        (Some(sticky), _) => return Ok(sticky),
        (None, Some(env)) => env,
        (None, None) => match fallback() {
            Some(role) => role,
            None => bail!(
                "no role configured: set PEBBLES_ROLE=main or PEBBLES_ROLE=engine, or run \
                 interactively to use the setup wizard"
            ),
        },
    };
    std::fs::write(&role_file, format!("{chosen}\n")).context("persisting role")?;
    Ok(chosen)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_wizard() -> Option<Role> {
        None
    }

    #[test]
    fn first_boot_persists_the_role_and_restarts_keep_it() {
        let dir = tempfile::tempdir().unwrap();
        let role = resolve_role(dir.path(), Some("main"), no_wizard).unwrap();
        assert_eq!(role, Role::Main);
        // Restart without the env var: sticky role wins.
        assert_eq!(
            resolve_role(dir.path(), None, no_wizard).unwrap(),
            Role::Main
        );
    }

    #[test]
    fn conflicting_env_role_is_an_error_not_a_silent_rerole() {
        let dir = tempfile::tempdir().unwrap();
        resolve_role(dir.path(), Some("engine"), no_wizard).unwrap();
        let err = resolve_role(dir.path(), Some("main"), no_wizard).unwrap_err();
        assert!(err.to_string().contains("already set up"));
    }

    #[test]
    fn wizard_answer_is_persisted_like_an_env_role() {
        let dir = tempfile::tempdir().unwrap();
        let role = resolve_role(dir.path(), None, || Some(Role::Engine)).unwrap();
        assert_eq!(role, Role::Engine);
        assert_eq!(
            resolve_role(dir.path(), None, no_wizard).unwrap(),
            Role::Engine
        );
    }

    #[test]
    fn missing_role_with_no_wizard_is_a_loud_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(resolve_role(dir.path(), None, no_wizard).is_err());
    }
}
