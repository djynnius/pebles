//! Container-runtime abstraction (implementation plan §4).
//!
//! `pebblesd` touches a runtime in exactly two places: launching/supervising
//! main-managed engines (REQ-04/22) and inspection for the Hosts screen. Sessions are
//! brokered by the `pebblesd` *inside* each engine over its API — never via `exec` —
//! so this trait stays deliberately small: no exec, no log-follow, no build.
//!
//! Drivers (landing M0.2+):
//! - Docker: `bollard` over `/var/run/docker.sock`
//! - Podman: the same `bollard` driver over the rootful docker-compat socket, with a
//!   small quirks table keyed off `GET /_ping` headers. Rootless sockets are detected
//!   and refused — rootless uid remapping silently breaks REQ-11.
//! - Incus: a thin hand-rolled REST client (~8 endpoints, async-operation polling).

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::Duration;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum RuntimeError {
    #[error("no supported container runtime socket found (probed docker, podman, incus)")]
    NoRuntimeDetected,
    #[error(
        "rootless Podman is not supported in v1: rootless uid remapping breaks the \
             host-uid identity model (REQ-11). Enable the rootful socket: \
             `systemctl enable --now podman.socket`"
    )]
    RootlessPodman,
    #[error("runtime API error: {0}")]
    Api(String),
}

/// Which backend a host uses. Probe order at first boot: Docker → Podman → Incus.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeKind {
    Docker,
    Podman,
    Incus,
}

impl RuntimeKind {
    /// Default rootful socket path for each backend.
    pub fn socket_path(self) -> &'static Path {
        match self {
            RuntimeKind::Docker => Path::new("/var/run/docker.sock"),
            RuntimeKind::Podman => Path::new("/run/podman/podman.sock"),
            RuntimeKind::Incus => Path::new("/var/lib/incus/unix.socket"),
        }
    }

    pub const PROBE_ORDER: [RuntimeKind; 3] =
        [RuntimeKind::Docker, RuntimeKind::Podman, RuntimeKind::Incus];
}

/// A contiguous 1:1 uid/gid idmap requirement (Incus `raw.idmap`, ADR-001 range).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct UidRange {
    pub min: u32,
    pub max: u32,
}

/// Everything needed to launch an engine container (REQ-21 subset; grows with M0.2+).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineSpec {
    pub name: String,
    pub image: String,
    pub config_volume: String,
    /// Host path bind-mounted so user homes resolve identically in-container.
    pub home_mount: String,
    pub memory_limit_bytes: Option<u64>,
    pub cpu_limit: Option<f64>,
    /// Required identity-mapped range on idmapping backends (Incus unprivileged).
    pub idmap: Option<UidRange>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContainerRef {
    pub id: String,
    pub runtime: RuntimeKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ContainerState {
    Running,
    Stopped,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContainerInfo {
    pub r#ref: ContainerRef,
    pub name: String,
    pub state: ContainerState,
}

/// What a backend can do; consulted by engine placement and config validation.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct RuntimeCaps {
    pub gpu_passthrough: bool,
    pub idmap: bool,
}

#[async_trait]
pub trait ContainerRuntime: Send + Sync {
    async fn launch_engine(&self, spec: &EngineSpec) -> Result<ContainerRef, RuntimeError>;
    async fn stop(&self, c: &ContainerRef, timeout: Duration) -> Result<(), RuntimeError>;
    async fn remove(&self, c: &ContainerRef) -> Result<(), RuntimeError>;
    async fn inspect(&self, c: &ContainerRef) -> Result<ContainerState, RuntimeError>;
    async fn list_pebbles_containers(&self) -> Result<Vec<ContainerInfo>, RuntimeError>;
    fn capabilities(&self) -> RuntimeCaps;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_order_is_docker_podman_incus() {
        assert_eq!(
            RuntimeKind::PROBE_ORDER,
            [RuntimeKind::Docker, RuntimeKind::Podman, RuntimeKind::Incus]
        );
    }

    #[test]
    fn socket_paths_are_the_documented_rootful_defaults() {
        assert_eq!(
            RuntimeKind::Podman.socket_path(),
            Path::new("/run/podman/podman.sock")
        );
        assert_eq!(
            RuntimeKind::Incus.socket_path(),
            Path::new("/var/lib/incus/unix.socket")
        );
    }
}
