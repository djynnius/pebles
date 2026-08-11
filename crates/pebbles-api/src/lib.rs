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
