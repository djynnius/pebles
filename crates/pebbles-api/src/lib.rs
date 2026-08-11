//! Request/response types for the `pebblesd` API.
//!
//! The Flask web tier's client is *generated* from the OpenAPI schema this crate
//! exports (`cargo run -p xtask -- api-schema`); CI fails if the generated client
//! drifts. That is what makes the NFR-01 privilege boundary mechanical.

use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;
use utoipa::{OpenApi, ToSchema};

/// The role a container adopts at first boot (REQ-03). Sticky in the config volume.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    /// Control plane: Postgres catalog, web UI, jobs, `pebblesd` supervisor.
    Main,
    /// Compute only: `pebblesd` in engine mode plus kernels.
    Engine,
}

impl FromStr for Role {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "main" => Ok(Role::Main),
            "engine" => Ok(Role::Engine),
            other => Err(format!(
                "invalid PEBBLES_ROLE {other:?}: expected \"main\" or \"engine\""
            )),
        }
    }
}

impl fmt::Display for Role {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Role::Main => write!(f, "main"),
            Role::Engine => write!(f, "engine"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Health {
    pub status: String,
    pub role: Role,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct VersionInfo {
    pub version: String,
}

/// Create a real UNIX account in the reserved Pebbles uid range (REQ-11).
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct CreateUserRequest {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct UserInfo {
    pub username: String,
    pub uid: u32,
    pub gid: u32,
    pub home: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

/// Successful login: the caller's verified identity.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct LoginResponse {
    pub username: String,
    pub uid: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ApiError {
    pub error: String,
}

/// Open an engine session as `username` (REQ-16/18/20).
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct OpenSessionRequest {
    pub username: String,
    /// "shared" (default) or "dedicated".
    #[serde(default)]
    pub mode: Option<String>,
    /// Per-session memory limit; the engine's default applies when omitted.
    #[serde(default)]
    pub memory_limit_bytes: Option<u64>,
    /// Engine to run on; the local engine when omitted. Choice is always explicit
    /// in the UI (REQ-17) — this default serves the single-box case.
    #[serde(default)]
    pub engine: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SessionDescriptor {
    pub id: u64,
    pub username: String,
    pub uid: u32,
    pub gid: u32,
    pub pid: u32,
    pub mode: String,
    pub memory_limit_bytes: u64,
    /// Which engine hosts the session; `None` = the local one.
    #[serde(default)]
    pub engine: Option<String>,
}

/// A minted single-use engine join token (REQ-05). The plaintext appears exactly
/// once, in this response; only its hash is stored.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct MintTokenResponse {
    pub id: String,
    pub token: String,
    pub expires_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct TokenInfo {
    pub id: String,
    pub expires_at: u64,
    pub used: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct EngineResources {
    pub cpus: u32,
    pub memory_bytes: u64,
}

/// An engine's registration handshake (REQ-05/26 + the uid-drift audit).
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct RegisterEngineRequest {
    pub token: String,
    pub name: String,
    /// Reachable base URL of the engine's cluster API, e.g. `http://10.0.0.7:7443`.
    pub address: String,
    pub resources: EngineResources,
    /// (uid, username) pairs already present in the reserved range on the engine —
    /// the main REFUSES registration on conflict (uid-drift mitigation).
    pub existing_users: Vec<(u32, String)>,
    /// Whether the lake root is reachable on the engine (REQ-26).
    pub lake_ok: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct IdentitySnapshot {
    pub passwd: String,
    pub shadow: String,
    /// In-range group lines (team groups + memberships, REQ-13/14).
    #[serde(default)]
    pub group: String,
}

/// A team group (REQ-13: all grants target groups).
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct GroupInfo {
    pub name: String,
    pub gid: u32,
    pub members: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct CreateGroupRequest {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AddMemberRequest {
    pub username: String,
}

/// Grant a group access to a catalog (REQ-13): Postgres role grants + setgid
/// group permissions on the data root, applied together.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct GrantCatalogRequest {
    pub group: String,
}

/// Engine visibility/attachability (REQ-07): "everyone" or "group:<name>".
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct EngineAccessRequest {
    pub access: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct RegisterEngineResponse {
    pub engine_id: String,
    /// Bearer secret for main↔engine calls. Plain HTTP in M1.1 — TLS hardening is
    /// scheduled before v1.0 (NFR-02).
    pub secret: String,
    pub identity: IdentitySnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct EngineDescriptor {
    pub name: String,
    pub address: String,
    /// "available" | "stopped" — the fuller REQ-23 state model lands with M1.3.
    pub state: String,
    pub resources: EngineResources,
    /// "everyone" or "group:<name>" (REQ-07).
    #[serde(default)]
    pub access: Option<String>,
}

/// Create a DuckLake catalog owned by `owner` (REQ-24/25). The form and the SQL
/// (`CREATE CATALOG <name>;`) are the same operation.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct CreateCatalogRequest {
    pub name: String,
    pub owner: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct CatalogDescriptor {
    pub name: String,
    pub owner: String,
    pub database: String,
    pub data_path: String,
    /// The equivalent SQL shown live in the UI (REQ-25).
    pub sql: String,
}

#[derive(OpenApi)]
#[openapi(
    info(title = "pebblesd", description = "Local privileged API for Pebbles"),
    components(schemas(
        Role,
        Health,
        VersionInfo,
        CreateUserRequest,
        UserInfo,
        LoginRequest,
        LoginResponse,
        OpenSessionRequest,
        SessionDescriptor,
        CreateCatalogRequest,
        CatalogDescriptor,
        MintTokenResponse,
        TokenInfo,
        EngineResources,
        RegisterEngineRequest,
        IdentitySnapshot,
        RegisterEngineResponse,
        EngineDescriptor,
        GroupInfo,
        CreateGroupRequest,
        AddMemberRequest,
        GrantCatalogRequest,
        EngineAccessRequest,
        ApiError
    ))
)]
pub struct ApiDoc;

/// The OpenAPI schema as pretty JSON (consumed by `xtask api-schema`).
pub fn openapi_json() -> String {
    ApiDoc::openapi()
        .to_pretty_json()
        .expect("static schema serializes")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn role_round_trips_through_serde_and_str() {
        for (s, role) in [("main", Role::Main), ("engine", Role::Engine)] {
            assert_eq!(s.parse::<Role>().unwrap(), role);
            assert_eq!(role.to_string(), s);
            assert_eq!(serde_json::to_string(&role).unwrap(), format!("{s:?}"));
        }
        assert!("cluster".parse::<Role>().is_err());
    }

    #[test]
    fn openapi_schema_is_valid_json() {
        let schema = openapi_json();
        let parsed: serde_json::Value = serde_json::from_str(&schema).unwrap();
        assert_eq!(parsed["info"]["title"], "pebblesd");
    }
}
