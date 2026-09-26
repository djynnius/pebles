//! Who may administer Pebbles. Admin is membership in the Pebbles group
//! `admins` — a real UNIX group in the reserved range, so the permission model
//! stays "UNIX accounts are the permission system" (no second ACL table).
//! The web tier enforces it on every admin route; pebblesd only guarantees the
//! group exists and is never empty.
//!
//! Bootstrap (idempotent, main role, at boot and after each user creation):
//!   1. the `admins` group exists;
//!   2. every user named in `PEBBLES_ADMINS` (comma-separated) is a member;
//!   3. if it still has no members, the first account ever created (lowest uid
//!      in the reserved range) is promoted — a fresh install's first user is its
//!      admin, and an upgraded install is never locked out.

use std::path::Path;

pub const ADMIN_GROUP: &str = "admins";

pub fn ensure_admins(config_dir: &Path) {
    if let Err(err) = ensure_inner(config_dir) {
        tracing::error!(%err, "admin group bootstrap failed");
    }
}

fn ensure_inner(config_dir: &Path) -> Result<(), pebbles_identity::IdentityError> {
    use pebbles_identity::host;
    let users = host::list_users()?;
    if users.is_empty() {
        return Ok(()); // nothing to administer yet; the first create_user retries
    }
    let mut changed = false;
    let group = match host::list_groups()?
        .into_iter()
        .find(|g| g.name == ADMIN_GROUP)
    {
        Some(g) => g,
        None => {
            changed = true;
            tracing::info!("creating the {ADMIN_GROUP} group");
            host::create_group(ADMIN_GROUP)?
        }
    };
    let mut members = group.members.clone();

    let named = std::env::var("PEBBLES_ADMINS").unwrap_or_default();
    for name in named.split(',').map(str::trim).filter(|n| !n.is_empty()) {
        if members.iter().any(|m| m == name) {
            continue;
        }
        if users.iter().any(|u| u.username == name) {
            host::add_member(ADMIN_GROUP, name)?;
            members.push(name.to_string());
            changed = true;
            tracing::info!(user = %name, "admin granted from PEBBLES_ADMINS");
        } else {
            tracing::warn!(user = %name, "PEBBLES_ADMINS names a user that doesn't exist");
        }
    }

    if members.is_empty() {
        if let Some(first) = users.iter().min_by_key(|u| u.uid) {
            host::add_member(ADMIN_GROUP, &first.username)?;
            changed = true;
            tracing::warn!(
                user = %first.username,
                "{ADMIN_GROUP} was empty — promoted the first account; add others with \
                 PEBBLES_ADMINS or the Groups screen"
            );
        }
    }
    if changed {
        host::persist_users(config_dir)?;
    }
    Ok(())
}
