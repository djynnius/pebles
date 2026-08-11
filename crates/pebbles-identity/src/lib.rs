//! UNIX identity for Pebbles (REQ-11..15).
//!
//! Pebbles users are real host accounts. Uids and gids must be identical on every
//! registered host; the main is the source of truth. All allocation happens inside
//! the reserved range below — see `docs/adr/ADR-001-uid-range.md` before changing
//! either constant. Changing the range after v1 ships means chowning every home and
//! lake file on every host.

use std::collections::BTreeSet;
use thiserror::Error;

/// First uid/gid Pebbles may allocate (ADR-001).
pub const PEBBLES_UID_MIN: u32 = 70000;
/// Last uid/gid Pebbles may allocate, inclusive (ADR-001).
pub const PEBBLES_UID_MAX: u32 = 74999;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum IdentityError {
    #[error("reserved uid range {min}-{max} is exhausted", min = PEBBLES_UID_MIN, max = PEBBLES_UID_MAX)]
    RangeExhausted,
    #[error("uid {0} is outside the reserved Pebbles range")]
    OutOfRange(u32),
    #[error("invalid username {0:?}: must match [a-z][a-z0-9_-]{{0,31}}")]
    InvalidUsername(String),
    #[error("user {0:?} already exists")]
    UserExists(String),
    #[error("user {0:?} does not exist")]
    NoSuchUser(String),
    #[error("{command} failed: {detail}")]
    CommandFailed { command: String, detail: String },
    #[error("io error: {0}")]
    Io(String),
}

impl From<std::io::Error> for IdentityError {
    fn from(e: std::io::Error) -> Self {
        IdentityError::Io(e.to_string())
    }
}

/// A provisioned host account inside the reserved range.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProvisionedUser {
    pub username: String,
    pub uid: u32,
    pub gid: u32,
    pub home: String,
}

/// Usernames are conservative on purpose: they become home paths, group names, and
/// shell arguments on every host in the fleet.
pub fn validate_username(name: &str) -> Result<(), IdentityError> {
    let mut chars = name.chars();
    let ok = name.len() <= 32
        && chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-');
    if ok {
        Ok(())
    } else {
        Err(IdentityError::InvalidUsername(name.to_string()))
    }
}

/// (uid, gid) for `name` from passwd-format content.
pub fn parse_passwd(content: &str, name: &str) -> Option<(u32, u32)> {
    content.lines().find_map(|line| {
        let fields: Vec<&str> = line.split(':').collect();
        if fields.len() >= 4 && fields[0] == name {
            Some((fields[2].parse().ok()?, fields[3].parse().ok()?))
        } else {
            None
        }
    })
}

/// gid for `name` from group-format content.
pub fn parse_group(content: &str, name: &str) -> Option<u32> {
    content.lines().find_map(|line| {
        let fields: Vec<&str> = line.split(':').collect();
        if fields.len() >= 3 && fields[0] == name {
            fields[2].parse().ok()
        } else {
            None
        }
    })
}

/// All in-range Pebbles users from passwd-format content.
pub fn pebbles_users(content: &str) -> Vec<ProvisionedUser> {
    content
        .lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split(':').collect();
            if fields.len() < 6 {
                return None;
            }
            let uid: u32 = fields[2].parse().ok()?;
            let gid: u32 = fields[3].parse().ok()?;
            (PEBBLES_UID_MIN..=PEBBLES_UID_MAX)
                .contains(&uid)
                .then(|| ProvisionedUser {
                    username: fields[0].to_string(),
                    uid,
                    gid,
                    home: fields[5].to_string(),
                })
        })
        .collect()
}

/// Verify `password` against a shadow-format database. Pure and testable; the
/// root-only read of `/etc/shadow` lives in [`host`]. Returns `NoSuchUser` when the
/// account is absent, `Ok(false)` for wrong passwords and locked accounts.
pub fn verify_in_shadow(shadow: &str, name: &str, password: &str) -> Result<bool, IdentityError> {
    let hash = shadow
        .lines()
        .find_map(|line| {
            let mut fields = line.split(':');
            (fields.next()? == name).then(|| fields.next().unwrap_or(""))
        })
        .ok_or_else(|| IdentityError::NoSuchUser(name.to_string()))?;
    // "!", "*", "" … mean no password login; only crypt hashes are verifiable.
    if !hash.starts_with('$') {
        return Ok(false);
    }
    Ok(pwhash::unix::verify(password, hash))
}

/// (uid, gid) for a host account, or `None` if it doesn't exist.
pub fn system_user(name: &str) -> Option<(u32, u32)> {
    parse_passwd(&std::fs::read_to_string("/etc/passwd").ok()?, name)
}

/// gid for a host group, or `None` if it doesn't exist.
pub fn system_group(name: &str) -> Option<u32> {
    parse_group(&std::fs::read_to_string("/etc/group").ok()?, name)
}

/// Allocates uids from the reserved range, lowest-free-first.
///
/// The set of used uids is seeded from the catalog (and audited against every host at
/// engine registration, which refuses on conflict — the PRD's uid-drift mitigation).
#[derive(Debug, Default)]
pub struct UidAllocator {
    used: BTreeSet<u32>,
    min: u32,
    max: u32,
}

impl UidAllocator {
    pub fn new(used: impl IntoIterator<Item = u32>) -> Self {
        Self::with_range(used, PEBBLES_UID_MIN, PEBBLES_UID_MAX)
    }

    fn with_range(used: impl IntoIterator<Item = u32>, min: u32, max: u32) -> Self {
        Self {
            used: used.into_iter().collect(),
            min,
            max,
        }
    }

    pub fn allocate(&mut self) -> Result<u32, IdentityError> {
        let next = (self.min..=self.max).find(|uid| !self.used.contains(uid));
        match next {
            Some(uid) => {
                self.used.insert(uid);
                Ok(uid)
            }
            None => Err(IdentityError::RangeExhausted),
        }
    }

    pub fn release(&mut self, uid: u32) -> Result<(), IdentityError> {
        if !(self.min..=self.max).contains(&uid) {
            return Err(IdentityError::OutOfRange(uid));
        }
        self.used.remove(&uid);
        Ok(())
    }
}

/// Host-mutating operations. Everything here shells out to the standard tooling
/// (`groupadd`/`useradd`/`chpasswd`) as root and is only reachable through
/// pebblesd's privileged API — never from the web tier directly (NFR-01).
pub mod host {
    use super::*;
    use std::io::Write;
    use std::process::{Command, Stdio};

    /// Create a real UNIX account (REQ-11/13): uid == gid (personal primary group),
    /// `/home/<name>` at mode 0700 — filesystem permissions ARE the permission
    /// system, so homes start private. Passwords are SHA-512 crypt so verification
    /// works from a static binary against the same shadow entry sshd uses (REQ-15).
    pub fn create_user(username: &str, password: &str) -> Result<ProvisionedUser, IdentityError> {
        validate_username(username)?;
        let passwd = std::fs::read_to_string("/etc/passwd")?;
        if parse_passwd(&passwd, username).is_some() {
            return Err(IdentityError::UserExists(username.to_string()));
        }
        let mut allocator = UidAllocator::new(pebbles_users(&passwd).iter().map(|u| u.uid));
        let uid = allocator.allocate()?;
        let id = uid.to_string();

        run("groupadd", &["-g", &id, username], None)?;
        run(
            "useradd",
            &["-u", &id, "-g", &id, "-m", "-s", "/bin/bash", username],
            None,
        )?;
        let home = format!("/home/{username}");
        set_mode(&home, 0o700)?;
        run(
            "chpasswd",
            &["-c", "SHA512"],
            Some(&format!("{username}:{password}\n")),
        )?;

        Ok(ProvisionedUser {
            username: username.to_string(),
            uid,
            gid: uid,
            home,
        })
    }

    /// Check a login against `/etc/shadow` (root-only read).
    pub fn verify_password(username: &str, password: &str) -> Result<bool, IdentityError> {
        validate_username(username)?;
        let shadow = std::fs::read_to_string("/etc/shadow")?;
        verify_in_shadow(&shadow, username, password)
    }

    /// Every account in the reserved Pebbles range.
    pub fn list_users() -> Result<Vec<ProvisionedUser>, IdentityError> {
        Ok(pebbles_users(&std::fs::read_to_string("/etc/passwd")?))
    }

    fn set_mode(path: &str, mode: u32) -> Result<(), IdentityError> {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))?;
        Ok(())
    }

    fn run(command: &str, args: &[&str], stdin: Option<&str>) -> Result<(), IdentityError> {
        let failed = |detail: String| IdentityError::CommandFailed {
            command: command.to_string(),
            detail,
        };
        let mut child = Command::new(command)
            .args(args)
            .stdin(if stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| failed(e.to_string()))?;
        if let Some(input) = stdin {
            child
                .stdin
                .take()
                .expect("piped stdin")
                .write_all(input.as_bytes())
                .map_err(|e| failed(e.to_string()))?;
        }
        let output = child
            .wait_with_output()
            .map_err(|e| failed(e.to_string()))?;
        if output.status.success() {
            Ok(())
        } else {
            Err(failed(String::from_utf8_lossy(&output.stderr).into_owned()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PASSWD: &str = "root:x:0:0:root:/root:/bin/bash\n\
                          postgres:x:102:104:PostgreSQL:/var/lib/postgresql:/bin/sh\n\
                          pebbles-web:x:998:997::/nonexistent:/usr/sbin/nologin\n\
                          maya:x:70000:70000::/home/maya:/bin/bash\n\
                          tomas:x:70002:70002::/home/tomas:/bin/bash\n";
    const GROUP: &str = "root:x:0:\npebbles:x:997:pebbles-web\n";

    #[test]
    fn parses_uid_and_gid_from_passwd_content() {
        assert_eq!(parse_passwd(PASSWD, "postgres"), Some((102, 104)));
        assert_eq!(parse_passwd(PASSWD, "pebbles-web"), Some((998, 997)));
        assert_eq!(parse_passwd(PASSWD, "nobody-here"), None);
    }

    #[test]
    fn parses_gid_from_group_content() {
        assert_eq!(parse_group(GROUP, "pebbles"), Some(997));
        assert_eq!(parse_group(GROUP, "wheel"), None);
    }

    #[test]
    fn lists_only_users_inside_the_reserved_range() {
        let users = pebbles_users(PASSWD);
        assert_eq!(users.len(), 2);
        assert_eq!(users[0].username, "maya");
        assert_eq!(users[0].uid, 70000);
        assert_eq!(users[1].home, "/home/tomas");
    }

    #[test]
    fn username_rules_are_enforced() {
        assert!(validate_username("maya").is_ok());
        assert!(validate_username("dr_okafor-2").is_ok());
        for bad in ["", "Maya", "1maya", "maya!", "a".repeat(33).as_str(), "-x"] {
            assert!(validate_username(bad).is_err(), "{bad:?} should be invalid");
        }
    }

    #[test]
    fn shadow_verification_accepts_the_right_password_only() {
        let hash = pwhash::sha512_crypt::hash("pebbles-demo-1").unwrap();
        let shadow = format!("maya:{hash}:19900:0:99999:7:::\nlocked:!:19900:0:99999:7:::\n");
        assert_eq!(
            verify_in_shadow(&shadow, "maya", "pebbles-demo-1"),
            Ok(true)
        );
        assert_eq!(verify_in_shadow(&shadow, "maya", "wrong"), Ok(false));
        assert_eq!(verify_in_shadow(&shadow, "locked", "anything"), Ok(false));
        assert_eq!(
            verify_in_shadow(&shadow, "ghost", "x"),
            Err(IdentityError::NoSuchUser("ghost".into()))
        );
    }

    #[test]
    fn allocates_lowest_free_uid_first() {
        let mut alloc = UidAllocator::new([PEBBLES_UID_MIN, PEBBLES_UID_MIN + 2]);
        assert_eq!(alloc.allocate(), Ok(PEBBLES_UID_MIN + 1));
        assert_eq!(alloc.allocate(), Ok(PEBBLES_UID_MIN + 3));
    }

    #[test]
    fn exhausted_range_is_refused_not_wrapped() {
        let mut alloc = UidAllocator::with_range([70000, 70001], 70000, 70001);
        assert_eq!(alloc.allocate(), Err(IdentityError::RangeExhausted));
    }

    #[test]
    fn release_rejects_uids_outside_the_range() {
        let mut alloc = UidAllocator::new([]);
        assert_eq!(alloc.release(1000), Err(IdentityError::OutOfRange(1000)));
        let uid = alloc.allocate().unwrap();
        assert_eq!(alloc.release(uid), Ok(()));
        assert_eq!(alloc.allocate(), Ok(uid));
    }
}
