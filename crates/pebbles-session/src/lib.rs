//! Session brokering (REQ-16..20).
//!
//! An engine hosts multiple concurrent sessions — one *process* per attached user,
//! forked with setuid/setgid to that user, cwd in their home. The container is
//! shared; the processes are not. [`AdmissionControl`] holds the REQ-20 math;
//! [`broker`] owns the kernel processes.

pub mod broker;

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionMode {
    /// Default: coexists with other sessions up to max-sessions and the memory sum.
    Shared,
    /// Opt-in exclusive use; may claim the engine's full memory allowance (REQ-18/20).
    Dedicated,
}

impl SessionMode {
    pub fn as_str(self) -> &'static str {
        match self {
            SessionMode::Shared => "shared",
            SessionMode::Dedicated => "dedicated",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSpec {
    pub user: String,
    pub uid: u32,
    pub gid: u32,
    pub mode: SessionMode,
    /// Per-session DuckDB `memory_limit` in bytes.
    pub memory_limit_bytes: u64,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum AdmissionError {
    #[error(
        "admitting this session would need {requested_total} bytes of a {engine_limit}-byte engine"
    )]
    MemoryExceeded {
        requested_total: u64,
        engine_limit: u64,
    },
    #[error("engine is at its max of {0} sessions")]
    MaxSessions(usize),
    #[error(
        "a dedicated session requires an empty engine; {0} sessions active (drains, never kills)"
    )]
    DedicatedNeedsEmptyEngine(usize),
}

/// REQ-20: refuse a new session when the sum of session memory limits would exceed the
/// engine's memory. Dedicated sessions may claim the whole allowance — that's their point.
/// Sessions are tracked by id so closing one releases its reservation.
#[derive(Debug, Clone)]
pub struct AdmissionControl {
    pub engine_memory_bytes: u64,
    pub max_sessions: usize,
    active: BTreeMap<u64, u64>,
}

impl AdmissionControl {
    pub fn new(engine_memory_bytes: u64, max_sessions: usize) -> Self {
        Self {
            engine_memory_bytes,
            max_sessions,
            active: BTreeMap::new(),
        }
    }

    pub fn admit(&mut self, id: u64, spec: &SessionSpec) -> Result<(), AdmissionError> {
        match spec.mode {
            SessionMode::Dedicated => {
                if !self.active.is_empty() {
                    // The caller resolves this by entering the Draining state (REQ-19);
                    // admission itself never kills or preempts.
                    return Err(AdmissionError::DedicatedNeedsEmptyEngine(self.active.len()));
                }
                self.active.insert(id, self.engine_memory_bytes);
                Ok(())
            }
            SessionMode::Shared => {
                if self.active.len() >= self.max_sessions {
                    return Err(AdmissionError::MaxSessions(self.max_sessions));
                }
                let requested_total: u64 =
                    self.active.values().sum::<u64>() + spec.memory_limit_bytes;
                if requested_total > self.engine_memory_bytes {
                    return Err(AdmissionError::MemoryExceeded {
                        requested_total,
                        engine_limit: self.engine_memory_bytes,
                    });
                }
                self.active.insert(id, spec.memory_limit_bytes);
                Ok(())
            }
        }
    }

    /// Release a session's reservation; unknown ids are a no-op.
    pub fn release(&mut self, id: u64) {
        self.active.remove(&id);
    }

    pub fn active_sessions(&self) -> usize {
        self.active.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shared(mem: u64) -> SessionSpec {
        SessionSpec {
            user: "maya".into(),
            uid: 70001,
            gid: 70001,
            mode: SessionMode::Shared,
            memory_limit_bytes: mem,
        }
    }

    #[test]
    fn admits_until_the_sum_of_limits_hits_the_engine_memory() {
        let mut ac = AdmissionControl::new(8, 10);
        assert!(ac.admit(1, &shared(4)).is_ok());
        assert!(ac.admit(2, &shared(4)).is_ok());
        assert_eq!(
            ac.admit(3, &shared(1)),
            Err(AdmissionError::MemoryExceeded {
                requested_total: 9,
                engine_limit: 8
            })
        );
    }

    #[test]
    fn releasing_a_session_frees_its_memory() {
        let mut ac = AdmissionControl::new(8, 10);
        assert!(ac.admit(1, &shared(8)).is_ok());
        assert!(ac.admit(2, &shared(8)).is_err());
        ac.release(1);
        assert!(ac.admit(2, &shared(8)).is_ok());
        assert_eq!(ac.active_sessions(), 1);
    }

    #[test]
    fn max_sessions_is_enforced_before_memory() {
        let mut ac = AdmissionControl::new(100, 1);
        assert!(ac.admit(1, &shared(1)).is_ok());
        assert_eq!(ac.admit(2, &shared(1)), Err(AdmissionError::MaxSessions(1)));
    }

    #[test]
    fn dedicated_claims_the_full_allowance_but_only_on_an_empty_engine() {
        let mut ac = AdmissionControl::new(8, 10);
        assert!(ac.admit(1, &shared(2)).is_ok());
        let dedicated = SessionSpec {
            mode: SessionMode::Dedicated,
            ..shared(0)
        };
        assert_eq!(
            ac.admit(2, &dedicated),
            Err(AdmissionError::DedicatedNeedsEmptyEngine(1))
        );

        let mut empty = AdmissionControl::new(8, 10);
        assert!(empty.admit(1, &dedicated).is_ok());
        assert_eq!(
            empty.admit(2, &shared(1)),
            Err(AdmissionError::MemoryExceeded {
                requested_total: 9,
                engine_limit: 8
            })
        );
    }
}
