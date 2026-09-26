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

/// A team group in the reserved range (REQ-13: all grants target groups; personal
/// primary groups are excluded here — they're implementation detail, not teams).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PebblesGroup {
    pub name: String,
    pub gid: u32,
    pub members: Vec<String>,
}

/// Team groups from group-format content: in-range gids that are NOT someone's
/// personal primary group (uid == gid with the same name in passwd).
pub fn pebbles_groups(group_content: &str, passwd_content: &str) -> Vec<PebblesGroup> {
    group_content
        .lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split(':').collect();
            if fields.len() < 4 {
                return None;
            }
            let gid: u32 = fields[2].parse().ok()?;
            if !(PEBBLES_UID_MIN..=PEBBLES_UID_MAX).contains(&gid) {
                return None;
            }
            if parse_passwd(passwd_content, fields[0]) == Some((gid, gid)) {
                return None; // personal primary group
            }
            Some(PebblesGroup {
                name: fields[0].to_string(),
                gid,
                members: fields[3]
                    .split(',')
                    .filter(|m| !m.is_empty())
                    .map(str::to_string)
                    .collect(),
            })
        })
        .collect()
}

/// Shadow lines belonging to the named users (for persistence into the config
/// volume — accounts must survive "pull new image, same volume" upgrades, REQ-09).
pub fn filter_shadow_lines<'a>(shadow: &'a str, names: &[&str]) -> Vec<&'a str> {
    shadow
        .lines()
        .filter(|line| {
            line.split(':')
                .next()
                .is_some_and(|name| names.contains(&name))
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
/// Shadow fields for a user: (hash, expire) — `None` if absent.
fn shadow_entry<'a>(shadow: &'a str, name: &str) -> Option<(&'a str, &'a str)> {
    shadow.lines().find_map(|line| {
        let f: Vec<&str> = line.split(':').collect();
        (f.first() == Some(&name)).then(|| {
            (
                f.get(1).copied().unwrap_or(""),
                f.get(7).copied().unwrap_or(""),
            )
        })
    })
}

/// Is the account disabled? Locked hash (`!…`) or an expiry date set.
pub fn is_disabled_in_shadow(shadow: &str, name: &str) -> bool {
    shadow_entry(shadow, name)
        .map(|(hash, expire)| hash.starts_with('!') || !expire.is_empty())
        .unwrap_or(false)
}

/// What an ENGINE must change to match the main's identity snapshot. The main
/// is the source of truth (REQ-11): accounts deleted there disappear here,
/// password and lock/expiry changes follow, revoked memberships and deleted
/// team groups are dropped. Pure — computed from file contents, so testable.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ReconcilePlan {
    pub delete_users: Vec<String>,
    /// (user, hash) — covers password changes AND lock state ('!' prefix).
    pub set_hashes: Vec<(String, String)>,
    /// (user, expire field — "" clears it).
    pub set_expiry: Vec<(String, String)>,
    pub remove_memberships: Vec<(String, String)>,
    pub delete_groups: Vec<String>,
}

pub fn reconcile_plan(
    stored_passwd: &str,
    stored_shadow: &str,
    stored_group: &str,
    live_passwd: &str,
    live_shadow: &str,
    live_group: &str,
) -> ReconcilePlan {
    let mut plan = ReconcilePlan::default();
    let stored_users = pebbles_users(stored_passwd);
    for live in pebbles_users(live_passwd) {
        if !stored_users.iter().any(|u| u.username == live.username) {
            plan.delete_users.push(live.username);
            continue;
        }
        let (Some((want_hash, want_exp)), Some((have_hash, have_exp))) = (
            shadow_entry(stored_shadow, &live.username),
            shadow_entry(live_shadow, &live.username),
        ) else {
            continue;
        };
        if want_hash != have_hash && !want_hash.is_empty() {
            plan.set_hashes
                .push((live.username.clone(), want_hash.to_string()));
        }
        if want_exp != have_exp {
            plan.set_expiry
                .push((live.username.clone(), want_exp.to_string()));
        }
    }
    let stored_groups = pebbles_groups(stored_group, stored_passwd);
    for live in pebbles_groups(live_group, live_passwd) {
        match stored_groups.iter().find(|g| g.name == live.name) {
            None => plan.delete_groups.push(live.name),
            Some(want) => {
                for m in &live.members {
                    if !want.members.contains(m) && !plan.delete_users.contains(m) {
                        plan.remove_memberships.push((live.name.clone(), m.clone()));
                    }
                }
            }
        }
    }
    plan
}

pub mod host {
    use super::*;
    use std::io::Write;
    use std::path::Path;
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
        // uid == gid (personal group), and team groups draw gids from the SAME
        // reserved pool — so the allocator must see both, or a user created
        // after a team group (e.g. `admins`) gets a uid whose gid is taken.
        let group = std::fs::read_to_string("/etc/group")?;
        let mut allocator = UidAllocator::new(
            pebbles_users(&passwd)
                .iter()
                .map(|u| u.uid)
                .chain(pebbles_groups(&group, &passwd).iter().map(|g| g.gid)),
        );
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

    /// One in-range account by name — `None` for absent OR out-of-range users, so
    /// callers can never resolve root/system accounts into a Pebbles identity.
    pub fn find_user(name: &str) -> Result<Option<ProvisionedUser>, IdentityError> {
        Ok(pebbles_users(&std::fs::read_to_string("/etc/passwd")?)
            .into_iter()
            .find(|u| u.username == name))
    }

    /// Snapshot every Pebbles account and team group (passwd + shadow + group
    /// lines) into the config volume so identity survives image upgrades
    /// (REQ-09/11) and replicates to engines (REQ-14). Root-only files.
    pub fn persist_users(state_dir: &Path) -> Result<(), IdentityError> {
        use std::os::unix::fs::PermissionsExt;
        let passwd = std::fs::read_to_string("/etc/passwd")?;
        let shadow = std::fs::read_to_string("/etc/shadow")?;
        let group = std::fs::read_to_string("/etc/group")?;
        let users = pebbles_users(&passwd);
        let names: Vec<&str> = users.iter().map(|u| u.username.as_str()).collect();

        let dir = state_dir.join("identity");
        std::fs::create_dir_all(&dir)?;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
        let passwd_lines: Vec<&str> = passwd
            .lines()
            .filter(|l| l.split(':').next().is_some_and(|n| names.contains(&n)))
            .collect();
        // All in-range group lines: team groups AND personal ones (memberships
        // ride on the group line; personal groups restore via useradd anyway).
        let group_lines: Vec<&str> = group
            .lines()
            .filter(|l| {
                l.split(':')
                    .nth(2)
                    .and_then(|g| g.parse::<u32>().ok())
                    .is_some_and(|g| (PEBBLES_UID_MIN..=PEBBLES_UID_MAX).contains(&g))
            })
            .collect();
        for (file, content) in [
            ("passwd", passwd_lines.join("\n")),
            ("shadow", filter_shadow_lines(&shadow, &names).join("\n")),
            ("group", group_lines.join("\n")),
        ] {
            let path = dir.join(file);
            std::fs::write(&path, format!("{content}\n"))?;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        }
        Ok(())
    }

    /// Names of disabled accounts (locked or expired) — root-only read.
    pub fn disabled_users() -> Vec<String> {
        let shadow = std::fs::read_to_string("/etc/shadow").unwrap_or_default();
        list_users()
            .unwrap_or_default()
            .into_iter()
            .filter(|u| super::is_disabled_in_shadow(&shadow, &u.username))
            .map(|u| u.username)
            .collect()
    }

    fn require_user(username: &str) -> Result<ProvisionedUser, IdentityError> {
        validate_username(username)?;
        find_user(username)?.ok_or_else(|| IdentityError::NoSuchUser(username.to_string()))
    }

    /// Set a new password (admin reset or self-service change — the caller
    /// decides who may). SHA-512 crypt, same as create_user.
    pub fn set_password(username: &str, password: &str) -> Result<(), IdentityError> {
        require_user(username)?;
        run(
            "chpasswd",
            &["-c", "SHA512"],
            Some(&format!("{username}:{password}\n")),
        )
    }

    /// Disable = lock the password AND expire the account, so neither a
    /// password nor an SSH key gets in (PAM's account phase refuses expired
    /// accounts). Enable reverses both. Replicates to engines via the shadow
    /// snapshot (see `reconcile_plan`).
    pub fn set_disabled(username: &str, disabled: bool) -> Result<(), IdentityError> {
        require_user(username)?;
        if disabled {
            run("usermod", &["-L", username], None)?;
            run("chage", &["-E", "0", username], None)
        } else {
            run("usermod", &["-U", username], None)?;
            run("chage", &["-E", "-1", username], None)
        }
    }

    /// Remove an account (and its personal group). `remove_home` deletes
    /// `/home/<name>` too — the main only; engines never pass it, since homes
    /// may be shared storage.
    pub fn delete_user(username: &str, remove_home: bool) -> Result<(), IdentityError> {
        require_user(username)?;
        if remove_home {
            run("userdel", &["-r", username], None)
        } else {
            run("userdel", &[username], None)
        }
    }

    pub fn delete_group(name: &str) -> Result<(), IdentityError> {
        validate_username(name)?;
        if !list_groups()?.iter().any(|g| g.name == name) {
            return Err(IdentityError::NoSuchUser(format!("group {name}")));
        }
        run("groupdel", &[name], None)
    }

    /// Engine side: converge the live account database on the main's snapshot
    /// (deletions, password/lock/expiry changes, revoked memberships, deleted
    /// team groups). Additions are `restore_users`' job. Returns actions taken.
    pub fn reconcile_to_snapshot(state_dir: &Path) -> Result<usize, IdentityError> {
        let dir = state_dir.join("identity");
        let Ok(stored_passwd) = std::fs::read_to_string(dir.join("passwd")) else {
            return Ok(0);
        };
        let plan = super::reconcile_plan(
            &stored_passwd,
            &std::fs::read_to_string(dir.join("shadow")).unwrap_or_default(),
            &std::fs::read_to_string(dir.join("group")).unwrap_or_default(),
            &std::fs::read_to_string("/etc/passwd")?,
            &std::fs::read_to_string("/etc/shadow").unwrap_or_default(),
            &std::fs::read_to_string("/etc/group")?,
        );
        let mut n = 0;
        for user in &plan.delete_users {
            run("userdel", &[user], None)?; // never -r: homes may be shared
            n += 1;
        }
        for (user, hash) in &plan.set_hashes {
            run("chpasswd", &["-e"], Some(&format!("{user}:{hash}\n")))?;
            n += 1;
        }
        for (user, expire) in &plan.set_expiry {
            let value = if expire.is_empty() {
                "-1"
            } else {
                expire.as_str()
            };
            run("chage", &["-E", value, user], None)?;
            n += 1;
        }
        for (group, user) in &plan.remove_memberships {
            run("gpasswd", &["-d", user, group], None)?;
            n += 1;
        }
        for group in &plan.delete_groups {
            run("groupdel", &[group], None)?;
            n += 1;
        }
        Ok(n)
    }

    /// Team groups on this host.
    pub fn list_groups() -> Result<Vec<PebblesGroup>, IdentityError> {
        Ok(pebbles_groups(
            &std::fs::read_to_string("/etc/group")?,
            &std::fs::read_to_string("/etc/passwd")?,
        ))
    }

    /// Create a team group with a gid from the shared reserved pool (uids and
    /// gids draw from one allocator so the fleet-wide audit stays simple).
    pub fn create_group(name: &str) -> Result<PebblesGroup, IdentityError> {
        validate_username(name)?;
        let passwd = std::fs::read_to_string("/etc/passwd")?;
        let group = std::fs::read_to_string("/etc/group")?;
        if parse_group(&group, name).is_some() || parse_passwd(&passwd, name).is_some() {
            return Err(IdentityError::UserExists(name.to_string()));
        }
        let used = pebbles_users(&passwd)
            .iter()
            .map(|u| u.uid)
            .chain(pebbles_groups(&group, &passwd).iter().map(|g| g.gid))
            .collect::<Vec<_>>();
        let gid = UidAllocator::new(used).allocate()?;
        run("groupadd", &["-g", &gid.to_string(), name], None)?;
        Ok(PebblesGroup {
            name: name.to_string(),
            gid,
            members: vec![],
        })
    }

    /// Membership changes are `usermod -aG` on a real group (REQ-14); sessions
    /// started afterwards inherit it (the broker initgroups at spawn).
    pub fn add_member(group: &str, username: &str) -> Result<(), IdentityError> {
        find_user(username)?.ok_or_else(|| IdentityError::NoSuchUser(username.to_string()))?;
        if !list_groups()?.iter().any(|g| g.name == group) {
            return Err(IdentityError::NoSuchUser(format!("group {group}")));
        }
        run("usermod", &["-aG", group, username], None)
    }

    pub fn remove_member(group: &str, username: &str) -> Result<(), IdentityError> {
        run("gpasswd", &["-d", username, group], None)
    }

    /// Is `username` in `group` (member list or personal primary)?
    pub fn in_group(username: &str, group: &str) -> bool {
        list_groups()
            .unwrap_or_default()
            .iter()
            .any(|g| g.name == group && g.members.iter().any(|m| m == username))
    }

    /// The persisted identity snapshot, if any (for replication to engines, REQ-14).
    pub fn read_snapshot(state_dir: &Path) -> Option<(String, String, String)> {
        let dir = state_dir.join("identity");
        Some((
            std::fs::read_to_string(dir.join("passwd")).ok()?,
            std::fs::read_to_string(dir.join("shadow")).unwrap_or_default(),
            std::fs::read_to_string(dir.join("group")).unwrap_or_default(),
        ))
    }

    /// Store a snapshot received from the main (engine side), then restore it into
    /// the live account database. Returns how many accounts were created.
    pub fn apply_snapshot(
        state_dir: &Path,
        passwd: &str,
        shadow: &str,
        group: &str,
    ) -> Result<usize, IdentityError> {
        use std::os::unix::fs::PermissionsExt;
        let dir = state_dir.join("identity");
        std::fs::create_dir_all(&dir)?;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
        for (file, content) in [("passwd", passwd), ("shadow", shadow), ("group", group)] {
            let path = dir.join(file);
            std::fs::write(&path, content)?;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        }
        let added = restore_users(state_dir)?;
        // Engines follow the main in BOTH directions: deletions, password and
        // lock changes, and revoked memberships reconcile too.
        let changed = reconcile_to_snapshot(state_dir)?;
        Ok(added + changed)
    }

    /// Recreate any persisted account missing from this container (fresh image,
    /// same config volume). Returns how many were restored.
    pub fn restore_users(state_dir: &Path) -> Result<usize, IdentityError> {
        use std::os::unix::fs::PermissionsExt;
        let dir = state_dir.join("identity");
        let Ok(stored_passwd) = std::fs::read_to_string(dir.join("passwd")) else {
            return Ok(0); // nothing persisted yet
        };
        let stored_shadow = std::fs::read_to_string(dir.join("shadow")).unwrap_or_default();
        let current = std::fs::read_to_string("/etc/passwd")?;

        let mut restored = 0;
        for user in pebbles_users(&stored_passwd) {
            if parse_passwd(&current, &user.username).is_some() {
                continue;
            }
            let id = user.uid.to_string();
            run("groupadd", &["-g", &id, &user.username], None)?;
            run(
                "useradd",
                &[
                    "-u",
                    &id,
                    "-g",
                    &id,
                    "-M",
                    "-d",
                    &user.home,
                    "-s",
                    "/bin/bash",
                    &user.username,
                ],
                None,
            )?;
            if !Path::new(&user.home).exists() {
                std::fs::create_dir_all(&user.home)?;
            }
            std::os::unix::fs::chown(&user.home, Some(user.uid), Some(user.gid))?;
            std::fs::set_permissions(&user.home, std::fs::Permissions::from_mode(0o700))?;
            if let Some(hash_line) = filter_shadow_lines(&stored_shadow, &[&user.username]).first()
            {
                if let Some(hash) = hash_line.split(':').nth(1) {
                    run(
                        "chpasswd",
                        &["-e"],
                        Some(&format!("{}:{hash}\n", user.username)),
                    )?;
                }
            }
            restored += 1;
        }

        // Team groups + memberships (REQ-13/14) ride the same snapshot.
        if let Ok(stored_group) = std::fs::read_to_string(dir.join("group")) {
            let stored_passwd_now = std::fs::read_to_string(dir.join("passwd"))?;
            let live_group = std::fs::read_to_string("/etc/group")?;
            for grp in pebbles_groups(&stored_group, &stored_passwd_now) {
                if parse_group(&live_group, &grp.name).is_none() {
                    run("groupadd", &["-g", &grp.gid.to_string(), &grp.name], None)?;
                }
                for member in &grp.members {
                    if !in_group(member, &grp.name) && find_user(member)?.is_some() {
                        run("usermod", &["-aG", &grp.name, member], None)?;
                    }
                }
            }
        }
        Ok(restored)
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

    #[test]
    fn engines_reconcile_deletes_password_lock_and_membership_changes() {
        let stored_passwd = "maya:x:70000:70000::/home/maya:/bin/bash\n\
                             tomas:x:70001:70001::/home/tomas:/bin/bash\n";
        let live_passwd = "maya:x:70000:70000::/home/maya:/bin/bash\n\
                           tomas:x:70001:70001::/home/tomas:/bin/bash\n\
                           gone:x:70002:70002::/home/gone:/bin/bash\n\
                           root:x:0:0:root:/root:/bin/bash\n";
        // maya's password changed; tomas was disabled (locked + expired)
        let stored_shadow = "maya:$6$new:1::::::\ntomas:!$6$t:1:::::1:\n";
        let live_shadow = "maya:$6$old:1::::::\ntomas:$6$t:1::::::\ngone:$6$g:1::::::\n";
        let stored_group = "maya:x:70000:\ntomas:x:70001:\nanalysts:x:70050:maya\n";
        let live_group = "maya:x:70000:\ntomas:x:70001:\ngone:x:70002:\n\
                          analysts:x:70050:maya,tomas\nold-team:x:70051:maya\n";

        let plan = reconcile_plan(
            stored_passwd,
            stored_shadow,
            stored_group,
            live_passwd,
            live_shadow,
            live_group,
        );
        assert_eq!(plan.delete_users, vec!["gone"]); // root is out of range: untouched
        assert_eq!(
            plan.set_hashes,
            vec![
                ("maya".into(), "$6$new".into()),
                ("tomas".into(), "!$6$t".into())
            ]
        );
        assert_eq!(plan.set_expiry, vec![("tomas".into(), "1".into())]);
        assert_eq!(
            plan.remove_memberships,
            vec![("analysts".into(), "tomas".into())]
        );
        assert_eq!(plan.delete_groups, vec!["old-team"]);

        // converged state → empty plan
        let same = reconcile_plan(
            stored_passwd,
            stored_shadow,
            stored_group,
            stored_passwd,
            stored_shadow,
            stored_group,
        );
        assert_eq!(same, ReconcilePlan::default());
    }

    #[test]
    fn disabled_means_locked_or_expired() {
        let shadow = "a:!$6$x:1::::::\nb:$6$x:1:::::1:\nc:$6$x:1::::::\n";
        assert!(is_disabled_in_shadow(shadow, "a"));
        assert!(is_disabled_in_shadow(shadow, "b"));
        assert!(!is_disabled_in_shadow(shadow, "c"));
    }

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
    fn shadow_lines_filter_to_the_named_users_only() {
        let shadow = "root:*:1::::::\nmaya:$6$abc:19900::::::\ntomas:$6$def:19900::::::\n";
        assert_eq!(
            filter_shadow_lines(shadow, &["maya", "tomas"]),
            vec!["maya:$6$abc:19900::::::", "tomas:$6$def:19900::::::"]
        );
        assert!(filter_shadow_lines(shadow, &["ghost"]).is_empty());
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
