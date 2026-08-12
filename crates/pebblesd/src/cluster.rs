//! Cluster membership (M1.1, REQ-05/11/14/26): single-use join tokens minted on the
//! main; engines register over the cluster TCP API, are audited for uid conflicts
//! (refused on drift), and receive the identity snapshot plus a bearer secret for
//! ongoing main↔engine calls.
//!
//! Transport is TLS with bearer auth (NFR-02): each side self-signs a sticky
//! certificate and peers pin its SHA-256 fingerprint trust-on-first-use (see
//! tls.rs) — fingerprints are exchanged in-band at registration.

use pebbles_api::{EngineResources, IdentitySnapshot, RegisterEngineRequest};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, RwLock};

pub const TOKEN_TTL_SECS: u64 = 24 * 60 * 60; // REQ-05 default expiry

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenRecord {
    pub id: String,
    pub token_hash: String,
    pub expires_at: u64,
    pub used: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineRecord {
    pub id: String,
    pub name: String,
    pub address: String,
    pub secret: String,
    pub resources: EngineResources,
    pub registered_at: u64,
    /// Pinned SHA-256 fingerprint of the engine's cluster TLS cert (NFR-02).
    #[serde(default)]
    pub cert_fp: Option<String>,
}

/// The engine side's own membership (sticky in its config volume).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineSelf {
    pub main: String,
    pub engine_id: String,
    pub secret: String,
    pub name: String,
    /// Pinned SHA-256 fingerprint of the main's cluster TLS cert (NFR-02).
    #[serde(default)]
    pub main_cert_fp: Option<String>,
}

/// An engine that contacted the main without a valid token (REQ-06): held for
/// admin approve/reject; the engine keeps retrying until a verdict lands.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingEngine {
    pub name: String,
    pub address: String,
    pub resources: EngineResources,
    pub first_seen: u64,
    #[serde(default)]
    pub approved: bool,
}

/// Access + grant records (REQ-07/13), sticky in the config volume.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Grants {
    /// catalog name → granted group names.
    #[serde(default)]
    pub catalogs: std::collections::HashMap<String, Vec<String>>,
    /// engine name → "everyone" | "group:<name>".
    #[serde(default)]
    pub engine_access: std::collections::HashMap<String, String>,
}

/// A remote session brokered through the main: local id → where it really lives.
#[derive(Debug, Clone)]
pub struct RemoteRef {
    pub engine_name: String,
    pub address: String,
    pub secret: String,
    pub remote_id: u64,
    /// The engine's pinned cert fingerprint, for the TLS client (NFR-02).
    pub cert_fp: Option<String>,
}

/// The disk shape of the remote map (NFR-08: through-main session handles must
/// survive a main restart). Address/secret are NOT persisted — they resolve
/// from the engine record at load, so a rotated secret invalidates stale refs.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedRemote {
    local_id: u64,
    engine_name: String,
    remote_id: u64,
}

/// Remote-session ids live above this offset so they can never collide with the
/// local broker's counter.
pub const REMOTE_ID_BASE: u64 = 1_000_000;

pub struct Cluster {
    dir: PathBuf,
    pub tokens: Mutex<Vec<TokenRecord>>,
    pub engines: Mutex<Vec<EngineRecord>>,
    pub pending: Mutex<Vec<PendingEngine>>,
    pub grants: Mutex<Grants>,
    /// Set on the engine role once registered; authenticates inbound main calls.
    pub engine_self: RwLock<Option<EngineSelf>>,
    remote: Mutex<std::collections::HashMap<u64, RemoteRef>>,
    next_remote: AtomicU64,
    /// Plain client for NON-cluster calls (Ollama probes). Cluster traffic
    /// goes through `peer_client` (TLS + pinning, NFR-02).
    pub http: reqwest::Client,
    /// Pinned TLS clients, one per peer fingerprint ("" = trust-on-first-use).
    peer_clients: Mutex<std::collections::HashMap<String, reqwest::Client>>,
    /// REQ-22: the health loop's cache — engine name → last observation.
    pub health: Mutex<std::collections::HashMap<String, EngineHealth>>,
}

/// What the 10s health loop last saw for one engine (REQ-22).
#[derive(Debug, Clone, Serialize)]
pub struct EngineHealth {
    /// The engine's own reported state ("available", "draining …", …).
    pub state: String,
    pub sessions: u64,
    /// Consecutive failed probes; >= LOST_AFTER flags the engine as lost.
    pub misses: u32,
    pub last_seen: u64,
}

/// Probes an engine may miss before it's flagged lost in the UI (3 × 10 s).
pub const LOST_AFTER: u32 = 3;
/// REQ-22's cadence.
pub const HEALTH_INTERVAL_SECS: u64 = 10;

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut buf))
        .expect("/dev/urandom");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn hash_token(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

impl Cluster {
    pub fn load(config_dir: &Path) -> std::sync::Arc<Self> {
        let dir = config_dir.join("cluster");
        let _ = std::fs::create_dir_all(&dir);
        let tokens = read_json(&dir.join("tokens.json")).unwrap_or_default();
        let engines: Vec<EngineRecord> = read_json(&dir.join("engines.json")).unwrap_or_default();
        let pending = read_json(&dir.join("pending.json")).unwrap_or_default();
        let grants = read_json(&dir.join("grants.json")).unwrap_or_default();
        let engine_self = read_json(&dir.join("engine.json"));

        // Restore through-main handles to sessions that survived our restart
        // (NFR-08): address/secret come from the live engine record; refs to
        // engines we no longer know are dropped.
        let persisted: Vec<PersistedRemote> =
            read_json(&dir.join("remote.json")).unwrap_or_default();
        let mut remote = std::collections::HashMap::new();
        let mut max_id = REMOTE_ID_BASE;
        for p in persisted {
            if let Some(engine) = engines.iter().find(|e| e.name == p.engine_name) {
                max_id = max_id.max(p.local_id);
                remote.insert(
                    p.local_id,
                    RemoteRef {
                        engine_name: engine.name.clone(),
                        address: engine.address.clone(),
                        secret: engine.secret.clone(),
                        remote_id: p.remote_id,
                        cert_fp: engine.cert_fp.clone(),
                    },
                );
            }
        }
        if !remote.is_empty() {
            tracing::info!(sessions = remote.len(), "restored remote session handles");
        }

        std::sync::Arc::new(Self {
            dir,
            tokens: Mutex::new(tokens),
            engines: Mutex::new(engines),
            pending: Mutex::new(pending),
            grants: Mutex::new(grants),
            engine_self: RwLock::new(engine_self),
            remote: Mutex::new(remote),
            next_remote: AtomicU64::new(max_id),
            http: reqwest::Client::new(),
            peer_clients: Mutex::new(std::collections::HashMap::new()),
            health: Mutex::new(std::collections::HashMap::new()),
        })
    }

    /// The HTTPS client for a cluster peer: pinned to `cert_fp` when we hold a
    /// pin, trust-on-first-use otherwise (NFR-02). Cached per fingerprint.
    pub fn peer_client(&self, cert_fp: Option<&str>) -> reqwest::Client {
        let key = cert_fp.unwrap_or("").to_string();
        let mut clients = self.peer_clients.lock().unwrap();
        clients
            .entry(key)
            .or_insert_with(|| crate::tls::pinned_client(cert_fp.map(str::to_string)))
            .clone()
    }

    fn persist_remote(&self, remote: &std::collections::HashMap<u64, RemoteRef>) {
        let persisted: Vec<PersistedRemote> = remote
            .iter()
            .map(|(local_id, r)| PersistedRemote {
                local_id: *local_id,
                engine_name: r.engine_name.clone(),
                remote_id: r.remote_id,
            })
            .collect();
        write_json(&self.dir.join("remote.json"), &persisted);
    }

    /// The health cache's verdict for an engine: `(state, sessions)`, where a
    /// lost engine (>= LOST_AFTER missed probes) reports "lost". None = the
    /// loop hasn't observed this engine yet (caller may probe inline once).
    pub fn engine_health(&self, name: &str) -> Option<(String, u64)> {
        let health = self.health.lock().unwrap();
        health.get(name).map(|h| {
            if h.misses >= LOST_AFTER {
                ("lost".to_string(), 0)
            } else {
                (h.state.clone(), h.sessions)
            }
        })
    }

    /// Record one probe result; returns the transition (was_lost, is_lost) so
    /// the loop logs edges, not every tick.
    pub fn note_probe(&self, name: &str, observed: Option<(String, u64)>) -> (bool, bool) {
        let mut health = self.health.lock().unwrap();
        let entry = health.entry(name.to_string()).or_insert(EngineHealth {
            state: "unknown".into(),
            sessions: 0,
            misses: 0,
            last_seen: 0,
        });
        let was_lost = entry.misses >= LOST_AFTER;
        match observed {
            Some((state, sessions)) => {
                entry.state = state;
                entry.sessions = sessions;
                entry.misses = 0;
                entry.last_seen = now();
            }
            None => entry.misses = entry.misses.saturating_add(1),
        }
        (was_lost, entry.misses >= LOST_AFTER)
    }

    /// Drop health records for engines that are no longer registered.
    pub fn prune_health(&self, registered: &[EngineRecord]) {
        let names: std::collections::HashSet<&str> =
            registered.iter().map(|e| e.name.as_str()).collect();
        self.health
            .lock()
            .unwrap()
            .retain(|name, _| names.contains(name.as_str()));
    }

    pub fn record_catalog_grant(&self, catalog: &str, group: &str) {
        let mut grants = self.grants.lock().unwrap();
        let entry = grants.catalogs.entry(catalog.to_string()).or_default();
        if !entry.iter().any(|g| g == group) {
            entry.push(group.to_string());
        }
        write_json(&self.dir.join("grants.json"), &*grants);
    }

    pub fn catalog_grants(&self, catalog: &str) -> Vec<String> {
        self.grants
            .lock()
            .unwrap()
            .catalogs
            .get(catalog)
            .cloned()
            .unwrap_or_default()
    }

    /// Does this group hold a grant on any catalog? (Membership adds re-wire
    /// Postgres roles only when needed.)
    pub fn catalog_grants_exist_for(&self, group: &str) -> bool {
        self.grants
            .lock()
            .unwrap()
            .catalogs
            .values()
            .flatten()
            .any(|g| g == group)
    }

    pub fn set_engine_access(&self, engine: &str, access: &str) {
        let mut grants = self.grants.lock().unwrap();
        grants
            .engine_access
            .insert(engine.to_string(), access.to_string());
        write_json(&self.dir.join("grants.json"), &*grants);
    }

    pub fn engine_access(&self, engine: &str) -> String {
        self.grants
            .lock()
            .unwrap()
            .engine_access
            .get(engine)
            .cloned()
            .unwrap_or_else(|| "everyone".to_string())
    }

    /// REQ-07: may `username` see/attach this engine?
    pub fn engine_allows(&self, engine: &str, username: &str) -> bool {
        match self.engine_access(engine).as_str() {
            "everyone" => true,
            spec => match spec.strip_prefix("group:") {
                Some(group) => pebbles_identity::host::in_group(username, group),
                None => false,
            },
        }
    }

    pub fn mint_token(&self) -> TokenRecord {
        let plaintext = random_hex(24);
        let record = TokenRecord {
            id: random_hex(4),
            token_hash: hash_token(&plaintext),
            expires_at: now() + TOKEN_TTL_SECS,
            used: false,
        };
        let mut tokens = self.tokens.lock().unwrap();
        tokens.push(record.clone());
        write_json(&self.dir.join("tokens.json"), &*tokens);
        // The plaintext travels back to the caller exactly once, via the hash field
        // swap below — never stored.
        TokenRecord {
            token_hash: plaintext,
            ..record
        }
    }

    pub fn revoke_token(&self, id: &str) -> bool {
        let mut tokens = self.tokens.lock().unwrap();
        let before = tokens.len();
        tokens.retain(|t| t.id != id);
        let changed = tokens.len() != before;
        if changed {
            write_json(&self.dir.join("tokens.json"), &*tokens);
        }
        changed
    }

    /// Consume a token: valid exactly once, before expiry (REQ-05).
    pub fn consume_token(&self, plaintext: &str) -> bool {
        let hash = hash_token(plaintext);
        let mut tokens = self.tokens.lock().unwrap();
        let Some(t) = tokens
            .iter_mut()
            .find(|t| t.token_hash == hash && !t.used && t.expires_at > now())
        else {
            return false;
        };
        t.used = true;
        write_json(&self.dir.join("tokens.json"), &*tokens);
        true
    }

    /// The REQ-11 audit: an engine claiming a uid the main knows under a different
    /// name (or vice versa) is refused — uid drift is a data-exposure bug.
    pub fn audit_uids(&self, reported: &[(u32, String)]) -> Result<(), String> {
        let ours = pebbles_identity::host::list_users().unwrap_or_default();
        for (uid, name) in reported {
            if let Some(known) = ours.iter().find(|u| u.uid == *uid) {
                if known.username != *name {
                    return Err(format!(
                        "uid {uid} is {:?} on the main but {name:?} on the engine",
                        known.username
                    ));
                }
            }
            if let Some(known) = ours.iter().find(|u| u.username == *name) {
                if known.uid != *uid {
                    return Err(format!(
                        "user {name:?} is uid {} on the main but {uid} on the engine",
                        known.uid
                    ));
                }
            }
        }
        Ok(())
    }

    pub fn register_engine(&self, req: &RegisterEngineRequest) -> EngineRecord {
        let record = EngineRecord {
            id: random_hex(4),
            name: req.name.clone(),
            address: req.address.trim_end_matches('/').to_string(),
            secret: random_hex(24),
            resources: req.resources.clone(),
            registered_at: now(),
            cert_fp: req.cert_fp.clone(),
        };
        let mut engines = self.engines.lock().unwrap();
        engines.retain(|e| e.name != record.name); // re-registration replaces
        engines.push(record.clone());
        write_json(&self.dir.join("engines.json"), &*engines);
        record
    }

    /// NFR-08/REQ-14 reconcile: an engine proving its existing id + secret gets
    /// its record refreshed (address may change under DHCP) and keeps its
    /// secret. None = this main doesn't know the pair (replaced volume, revoked
    /// engine) — the caller falls back to the token/pending path.
    pub fn reregister(&self, req: &RegisterEngineRequest) -> Option<EngineRecord> {
        let (id, secret) = (req.engine_id.as_ref()?, req.secret.as_ref()?);
        let mut engines = self.engines.lock().unwrap();
        let record = engines
            .iter_mut()
            .find(|e| &e.id == id && &e.secret == secret)?;
        record.name = req.name.clone();
        record.address = req.address.trim_end_matches('/').to_string();
        record.resources = req.resources.clone();
        if req.cert_fp.is_some() {
            record.cert_fp = req.cert_fp.clone();
        }
        let refreshed = record.clone();
        write_json(&self.dir.join("engines.json"), &*engines);
        Some(refreshed)
    }

    /// Tokenless contact (REQ-06): record/refresh the pending request. Returns
    /// true when an admin has approved it — the caller then completes
    /// registration and consumes the approval.
    pub fn note_pending(&self, req: &RegisterEngineRequest) -> bool {
        let mut pending = self.pending.lock().unwrap();
        if let Some(existing) = pending.iter_mut().find(|p| p.name == req.name) {
            existing.address = req.address.trim_end_matches('/').to_string();
            existing.resources = req.resources.clone();
            let approved = existing.approved;
            if approved {
                pending.retain(|p| p.name != req.name);
            }
            write_json(&self.dir.join("pending.json"), &*pending);
            return approved;
        }
        pending.push(PendingEngine {
            name: req.name.clone(),
            address: req.address.trim_end_matches('/').to_string(),
            resources: req.resources.clone(),
            first_seen: now(),
            approved: false,
        });
        write_json(&self.dir.join("pending.json"), &*pending);
        false
    }

    pub fn list_pending(&self) -> Vec<PendingEngine> {
        self.pending.lock().unwrap().clone()
    }

    /// Approve (true) or reject (false) a pending engine. Returns whether it existed.
    pub fn resolve_pending(&self, name: &str, approve: bool) -> bool {
        let mut pending = self.pending.lock().unwrap();
        let found = if approve {
            match pending.iter_mut().find(|p| p.name == name) {
                Some(p) => {
                    p.approved = true;
                    true
                }
                None => false,
            }
        } else {
            let before = pending.len();
            pending.retain(|p| p.name != name);
            pending.len() != before
        };
        if found {
            write_json(&self.dir.join("pending.json"), &*pending);
        }
        found
    }

    /// Deregister (REQ-08): the record — and with it the engine's secret — is gone;
    /// the main will neither route sessions to it nor accept its calls.
    pub fn deregister(&self, name: &str) -> bool {
        let mut engines = self.engines.lock().unwrap();
        let before = engines.len();
        engines.retain(|e| e.name != name);
        let removed = engines.len() != before;
        if removed {
            write_json(&self.dir.join("engines.json"), &*engines);
        }
        removed
    }

    pub fn engine_by_name(&self, name: &str) -> Option<EngineRecord> {
        self.engines
            .lock()
            .unwrap()
            .iter()
            .find(|e| e.name == name)
            .cloned()
    }

    pub fn list_engines(&self) -> Vec<EngineRecord> {
        self.engines.lock().unwrap().clone()
    }

    pub fn save_engine_self(&self, me: EngineSelf) {
        write_json(&self.dir.join("engine.json"), &me);
        *self.engine_self.write().unwrap() = Some(me);
    }

    pub fn map_remote(&self, engine: &EngineRecord, remote_id: u64) -> u64 {
        let local = self.next_remote.fetch_add(1, Ordering::SeqCst) + 1;
        let mut remote = self.remote.lock().unwrap();
        remote.insert(
            local,
            RemoteRef {
                engine_name: engine.name.clone(),
                address: engine.address.clone(),
                secret: engine.secret.clone(),
                remote_id,
                cert_fp: engine.cert_fp.clone(),
            },
        );
        self.persist_remote(&remote);
        local
    }

    pub fn remote_of(&self, local_id: u64) -> Option<RemoteRef> {
        self.remote.lock().unwrap().get(&local_id).cloned()
    }

    pub fn unmap_remote(&self, local_id: u64) {
        let mut remote = self.remote.lock().unwrap();
        remote.remove(&local_id);
        self.persist_remote(&remote);
    }

    /// Push the current identity snapshot to every engine (REQ-14); best-effort,
    /// loudly logged — engines reconcile again at their next registration.
    pub async fn push_accounts(&self, config_dir: &Path) {
        let Some((passwd, shadow, group)) = pebbles_identity::host::read_snapshot(config_dir)
        else {
            return;
        };
        let snapshot = IdentitySnapshot {
            passwd,
            shadow,
            group,
        };
        for engine in self.list_engines() {
            let url = format!("{}/engine/sync-accounts", engine.address);
            match self
                .peer_client(engine.cert_fp.as_deref())
                .post(&url)
                .bearer_auth(&engine.secret)
                .json(&snapshot)
                .send()
                .await
            {
                Ok(resp) if resp.status().is_success() => {
                    tracing::info!(engine = %engine.name, "accounts replicated");
                }
                Ok(resp) => {
                    tracing::error!(engine = %engine.name, status = %resp.status(), "account replication rejected");
                }
                Err(err) => {
                    tracing::error!(engine = %engine.name, %err, "account replication failed");
                }
            }
        }
    }
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

fn write_json<T: Serialize>(path: &Path, value: &T) {
    use std::os::unix::fs::PermissionsExt;
    match serde_json::to_string_pretty(value) {
        Ok(json) => {
            if let Err(err) = std::fs::write(path, json) {
                tracing::error!(path = %path.display(), %err, "cannot persist cluster state");
            }
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        }
        Err(err) => tracing::error!(%err, "cannot serialize cluster state"),
    }
}

/// Engine-role boot: register with the main (retrying — the main may not be up
/// yet), verify the lake path (REQ-26), and apply the identity snapshot.
/// REQ-22: the main probes every registered engine every 10 s. A miss is
/// tolerated LOST_AFTER times, then the engine is flagged "lost" in the UI
/// (distinct from "stopped": stopped is an engine's own report, lost means we
/// can't reach it at all). Transitions log at warn/info; steady state is
/// silent. Auto-restart hook: engines the main itself launched (REQ-21, not
/// yet built) would be restarted here through their ContainerRuntime driver —
/// remotely-joined engines can only be flagged, their host owns their
/// lifecycle. Engines that reconnect re-register themselves (NFR-08), which
/// the next probe observes.
pub async fn health_loop(cluster: std::sync::Arc<Cluster>) {
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(HEALTH_INTERVAL_SECS)).await;
        let engines = cluster.list_engines();
        cluster.prune_health(&engines);
        for engine in engines {
            let observed = match cluster
                .peer_client(engine.cert_fp.as_deref())
                .get(format!("{}/engine/state", engine.address))
                .bearer_auth(&engine.secret)
                .timeout(std::time::Duration::from_secs(3))
                .send()
                .await
            {
                Ok(resp) if resp.status().is_success() => resp
                    .json::<pebbles_api::EngineStatus>()
                    .await
                    .ok()
                    .map(|s| (s.state, s.sessions)),
                _ => None,
            };
            let alive = observed.is_some();
            let (was_lost, is_lost) = cluster.note_probe(&engine.name, observed);
            match (was_lost, is_lost, alive) {
                (false, true, _) => tracing::warn!(
                    engine = %engine.name, address = %engine.address,
                    "engine lost: {LOST_AFTER} consecutive probes failed (REQ-22)"
                ),
                (true, false, true) => {
                    tracing::info!(engine = %engine.name, "engine recovered")
                }
                _ => {}
            }
        }
    }
}

/// How often a registered engine reconciles with its main (NFR-08/REQ-14):
/// refreshes its record (address may change), re-applies the identity
/// snapshot (accounts created while it was down arrive here), and re-enters
/// the pending queue automatically if the main was replaced.
const RECONCILE_INTERVAL_SECS: u64 = 60;

pub async fn engine_boot(config_dir: PathBuf, cluster: std::sync::Arc<Cluster>) {
    // Sticky identity: the stored main URL outlives the env (which is only
    // guaranteed on first boot).
    let sticky = cluster.engine_self.read().unwrap().clone();
    let main = match std::env::var("PEBBLES_MAIN")
        .ok()
        .or_else(|| sticky.as_ref().map(|s| s.main.clone()))
    {
        // The cluster API is TLS-only (NFR-02): a plain-http main URL from an
        // older config or a habit-typed env is upgraded, loudly.
        Some(m) => {
            let m = m.trim_end_matches('/');
            if let Some(rest) = m.strip_prefix("http://") {
                tracing::warn!(
                    "PEBBLES_MAIN is http:// — the cluster API is TLS-only, using https://"
                );
                format!("https://{rest}")
            } else if m.starts_with("https://") {
                m.to_string()
            } else {
                format!("https://{m}")
            }
        }
        None => {
            tracing::error!("engine role without registration: set PEBBLES_MAIN");
            return;
        }
    };
    // Our own cert fingerprint, self-reported so the main can pin us.
    let my_cert_fp = crate::tls::ensure_cert(&config_dir)
        .ok()
        .and_then(|(cert, _)| crate::tls::fingerprint_pem(&cert));
    // No token → the pending-approval flow (REQ-06): keep knocking until an
    // admin approves or rejects on the main. Registered engines don't need
    // one — they prove themselves with their id + secret.
    let token = std::env::var("PEBBLES_JOIN_TOKEN").unwrap_or_default();
    if token.is_empty() && sticky.is_none() {
        tracing::warn!("no join token: requesting registration as PENDING APPROVAL");
    }

    let name = std::env::var("PEBBLES_ENGINE_NAME")
        .ok()
        .or_else(|| sticky.as_ref().map(|s| s.name.clone()))
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| format!("engine-{}", random_hex(2)));

    loop {
        // Rebuilt every attempt: users, lake reachability, address, and our
        // current identity all drift over time.
        let lake_root = crate::catalog::lake_root();
        let lake_ok = lake_root.exists();
        if !lake_ok {
            // REQ-26: fail loudly — an engine that can't see the lake is useless.
            tracing::error!(lake = %lake_root.display(), "LAKE PATH NOT REACHABLE on this engine");
        }
        let me = cluster.engine_self.read().unwrap().clone();
        let registered = me.is_some();
        let request = RegisterEngineRequest {
            token: token.clone(),
            name: name.clone(),
            address: advertise_address(&main),
            resources: EngineResources {
                cpus: std::thread::available_parallelism()
                    .map(|n| n.get() as u32)
                    .unwrap_or(1),
                memory_bytes: total_memory_bytes(),
            },
            existing_users: pebbles_identity::host::list_users()
                .unwrap_or_default()
                .into_iter()
                .map(|u| (u.uid, u.username))
                .collect(),
            lake_ok,
            engine_id: me.as_ref().map(|s| s.engine_id.clone()),
            secret: me.as_ref().map(|s| s.secret.clone()),
            cert_fp: my_cert_fp.clone(),
        };

        // Pinned to the main's cert once known; trust-on-first-use before.
        let main_fp = me.as_ref().and_then(|s| s.main_cert_fp.clone());
        match cluster
            .peer_client(main_fp.as_deref())
            .post(format!("{main}/cluster/register"))
            .json(&request)
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                match resp.json::<pebbles_api::RegisterEngineResponse>().await {
                    Ok(granted) => {
                        match pebbles_identity::host::apply_snapshot(
                            &config_dir,
                            &granted.identity.passwd,
                            &granted.identity.shadow,
                            &granted.identity.group,
                        ) {
                            Ok(0) => {}
                            Ok(n) => tracing::info!(accounts = n, "identity snapshot applied"),
                            Err(err) => tracing::error!(%err, "applying identity snapshot failed"),
                        }
                        let fresh =
                            !registered || me.as_ref().is_some_and(|s| s.secret != granted.secret);
                        cluster.save_engine_self(EngineSelf {
                            main: main.clone(),
                            engine_id: granted.engine_id,
                            secret: granted.secret,
                            name: name.clone(),
                            // Pin the main's cert (keep an existing pin if the
                            // response omitted one).
                            main_cert_fp: granted.main_cert_fp.or(main_fp.clone()),
                        });
                        if fresh {
                            tracing::info!(engine = %name, main = %main, "registered with the main");
                        }
                    }
                    Err(err) => tracing::error!(%err, "malformed registration response"),
                }
            }
            Ok(resp) if resp.status() == reqwest::StatusCode::ACCEPTED => {
                tracing::info!("pending admin approval on the main; retrying");
            }
            Ok(resp) => {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                tracing::error!(%status, body, "registration refused");
                if !registered
                    && (status == reqwest::StatusCode::UNAUTHORIZED
                        || status == reqwest::StatusCode::CONFLICT)
                {
                    return; // bad/used token or uid drift: retrying won't help
                }
                // Registered engines keep reconciling: a replaced main routes
                // us into its pending queue via the tokenless path above.
            }
            Err(err) => {
                if registered {
                    tracing::debug!(%err, "main unreachable; will reconcile again");
                } else {
                    tracing::warn!(%err, "main unreachable; retrying");
                }
            }
        }
        let sleep = if cluster.engine_self.read().unwrap().is_some() {
            RECONCILE_INTERVAL_SECS
        } else {
            10
        };
        tokio::time::sleep(std::time::Duration::from_secs(sleep)).await;
    }
}

/// The address the main should call back on: env override, else the local IP used
/// to reach the main (UDP connect trick — no packets sent).
fn advertise_address(main: &str) -> String {
    if let Ok(addr) = std::env::var("PEBBLES_ADVERTISE_ADDR") {
        return addr.trim_end_matches('/').to_string();
    }
    let port = crate::cluster_port();
    let host = main
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .split('/')
        .next()
        .unwrap_or("")
        .to_string();
    let ip = std::net::UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| {
            s.connect(&host)?;
            s.local_addr()
        })
        .map(|a| a.ip().to_string())
        .unwrap_or_else(|_| "127.0.0.1".to_string());
    format!("https://{ip}:{port}")
}

fn total_memory_bytes() -> u64 {
    std::fs::read_to_string("/proc/meminfo")
        .ok()
        .and_then(|m| {
            m.lines()
                .find(|l| l.starts_with("MemTotal:"))?
                .split_whitespace()
                .nth(1)?
                .parse::<u64>()
                .ok()
        })
        .map(|kb| kb * 1024)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cluster() -> std::sync::Arc<Cluster> {
        let dir = tempfile::tempdir().unwrap();
        let c = Cluster::load(dir.path());
        std::mem::forget(dir); // keep the backing dir alive for the test
        c
    }

    fn register_req(name: &str) -> RegisterEngineRequest {
        RegisterEngineRequest {
            token: "t".into(),
            name: name.into(),
            address: "http://10.0.0.7:7443".into(),
            resources: EngineResources {
                cpus: 4,
                memory_bytes: 0,
            },
            existing_users: vec![],
            lake_ok: true,
            engine_id: None,
            secret: None,
            cert_fp: None,
        }
    }

    #[test]
    fn reregistration_requires_the_exact_id_and_secret() {
        let c = cluster();
        let record = c.register_engine(&register_req("w1"));

        // right pair: record refreshed (new address), same secret
        let mut req = register_req("w1");
        req.address = "http://10.0.0.9:7443/".into();
        req.engine_id = Some(record.id.clone());
        req.secret = Some(record.secret.clone());
        let refreshed = c.reregister(&req).expect("known engine reconciles");
        assert_eq!(refreshed.secret, record.secret);
        assert_eq!(refreshed.address, "http://10.0.0.9:7443");

        // wrong secret: refused — falls back to the token/pending path
        let mut bad = register_req("w1");
        bad.engine_id = Some(record.id.clone());
        bad.secret = Some("stolen".into());
        assert!(c.reregister(&bad).is_none());

        // a replaced main knows nothing: refused
        let fresh = cluster();
        let mut req = register_req("w1");
        req.engine_id = Some(record.id);
        req.secret = Some(record.secret);
        assert!(fresh.reregister(&req).is_none());
    }

    #[test]
    fn remote_session_handles_survive_a_reload() {
        let dir = tempfile::tempdir().unwrap();
        let c = Cluster::load(dir.path());
        let record = c.register_engine(&register_req("w1"));
        let local = c.map_remote(&record, 7);
        assert!(local > REMOTE_ID_BASE);

        // a fresh Cluster over the same dir (main restarted) still routes it
        let reloaded = Cluster::load(dir.path());
        let r = reloaded.remote_of(local).expect("handle survived restart");
        assert_eq!(r.remote_id, 7);
        assert_eq!(r.engine_name, "w1");
        // new ids never collide with restored ones
        let record2 = reloaded.engine_by_name("w1").unwrap();
        assert!(reloaded.map_remote(&record2, 8) > local);

        // unmap persists too
        reloaded.unmap_remote(local);
        let again = Cluster::load(dir.path());
        assert!(again.remote_of(local).is_none());
    }

    #[test]
    fn health_probes_flag_lost_engines_and_recovery() {
        let c = cluster();
        // unknown engine: no verdict yet
        assert!(c.engine_health("w1").is_none());

        // healthy probes cache the engine's own state
        c.note_probe("w1", Some(("available".into(), 2)));
        assert_eq!(c.engine_health("w1"), Some(("available".into(), 2)));

        // misses below the threshold keep the last-known state (a blip)
        c.note_probe("w1", None);
        c.note_probe("w1", None);
        assert_eq!(c.engine_health("w1"), Some(("available".into(), 2)));

        // the LOST_AFTER'th miss flips it to lost, with the edge reported once
        let (was_lost, is_lost) = c.note_probe("w1", None);
        assert!(!was_lost && is_lost);
        assert_eq!(c.engine_health("w1"), Some(("lost".into(), 0)));

        // one good probe recovers it
        let (was_lost, is_lost) = c.note_probe("w1", Some(("available".into(), 1)));
        assert!(was_lost && !is_lost);
        assert_eq!(c.engine_health("w1"), Some(("available".into(), 1)));

        // deregistered engines fall out of the cache
        c.prune_health(&[]);
        assert!(c.engine_health("w1").is_none());
    }

    #[test]
    fn tokens_are_single_use_and_hashed_at_rest() {
        let c = cluster();
        let minted = c.mint_token();
        let plaintext = minted.token_hash.clone(); // swapped field carries plaintext
        assert!(!c
            .tokens
            .lock()
            .unwrap()
            .iter()
            .any(|t| t.token_hash == plaintext));
        assert!(c.consume_token(&plaintext));
        assert!(!c.consume_token(&plaintext), "second use must fail");
        assert!(!c.consume_token("nonsense"));
    }

    #[test]
    fn revoking_a_token_prevents_its_use() {
        let c = cluster();
        let minted = c.mint_token();
        assert!(c.revoke_token(&minted.id));
        assert!(!c.consume_token(&minted.token_hash));
    }

    #[test]
    fn remote_session_ids_never_collide_with_local_ones() {
        let c = cluster();
        let engine = EngineRecord {
            id: "e1".into(),
            name: "gpu-1".into(),
            address: "https://10.0.0.7:7443".into(),
            secret: "s".into(),
            resources: EngineResources {
                cpus: 4,
                memory_bytes: 1,
            },
            registered_at: 0,
            cert_fp: None,
        };
        let local = c.map_remote(&engine, 1);
        assert!(local > REMOTE_ID_BASE);
        assert_eq!(c.remote_of(local).unwrap().remote_id, 1);
        c.unmap_remote(local);
        assert!(c.remote_of(local).is_none());
    }
}
