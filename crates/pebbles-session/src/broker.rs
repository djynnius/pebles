//! The session broker: one kernel process per attached user, forked with
//! setuid/setgid to that user, cwd their home (REQ-12/16). Kernels speak JSON-lines
//! on stdio; the first line is a handshake that reports the kernel's actual uid —
//! the broker refuses the session if it doesn't match the requested user, so a
//! misconfigured spawn can never run as the wrong identity.

use crate::{AdmissionControl, AdmissionError, SessionMode, SessionSpec};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const EXEC_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error(transparent)]
    Admission(#[from] AdmissionError),
    #[error("session {0} not found")]
    NotFound(u64),
    #[error("kernel failed: {0}")]
    Kernel(String),
    #[error("kernel handshake failed: {0}")]
    Handshake(String),
    #[error("engine is draining — reserved for {0}; no new shared sessions start (REQ-19)")]
    Draining(String),
    #[error("a dedicated reservation is already pending for {0}")]
    ReservationHeld(String),
    #[error("dedicated sessions are disabled on this engine")]
    DedicatedDisabled,
}

/// What opening a session yields: a live session, or — for a dedicated request on
/// a busy engine — a reservation that fulfills when the engine drains empty.
/// Never refusal, never preemption (REQ-19).
pub enum OpenOutcome {
    Session(SessionInfo),
    Reserved(ReservationView),
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ReservationView {
    pub username: String,
    pub waited_secs: u64,
    pub notified: bool,
}

/// The engine's user-facing state (REQ-23 subset; grows in the UI).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineState {
    Available,
    InUse(usize),
    Draining(String),
    Dedicated(String),
}

struct PendingReservation {
    request: OpenRequest,
    requested_at: Instant,
    notified: bool,
    fulfilled: Option<SessionInfo>,
}

#[derive(Debug, Clone)]
pub struct OpenRequest {
    pub username: String,
    pub uid: u32,
    pub gid: u32,
    pub home: String,
    pub mode: SessionMode,
    pub memory_limit_bytes: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SessionInfo {
    pub id: u64,
    pub username: String,
    pub uid: u32,
    pub gid: u32,
    pub pid: u32,
    pub mode: SessionMode,
    pub memory_limit_bytes: u64,
}

pub struct BrokerConfig {
    pub kernel: PathBuf,
    pub engine_memory_bytes: u64,
    pub max_sessions: usize,
    pub idle_timeout: Duration,
    /// Per-engine toggle (REQ-18).
    pub allow_dedicated: bool,
    /// Notify the requester when a drain has waited this long (REQ-19; default 15 min).
    pub drain_notify: Duration,
}

struct SessionIo {
    stdin: ChildStdin,
    stdout: Lines<BufReader<ChildStdout>>,
    child: Child,
}

struct SessionEntry {
    info: SessionInfo,
    last_used: StdMutex<Instant>,
    io: Arc<Mutex<SessionIo>>,
}

pub struct Broker {
    cfg: BrokerConfig,
    admission: StdMutex<AdmissionControl>,
    sessions: StdMutex<HashMap<u64, Arc<SessionEntry>>>,
    reservation: StdMutex<Option<PendingReservation>>,
    next_id: AtomicU64,
}

impl Broker {
    /// Build the broker and start its idle reaper (idle sessions close after
    /// `idle_timeout` — the auto-stop side of REQ-18/21; dedicated sessions
    /// auto-release the same way).
    pub fn start(cfg: BrokerConfig) -> Arc<Self> {
        let admission = AdmissionControl::new(cfg.engine_memory_bytes, cfg.max_sessions);
        let broker = Arc::new(Self {
            cfg,
            admission: StdMutex::new(admission),
            sessions: StdMutex::new(HashMap::new()),
            reservation: StdMutex::new(None),
            next_id: AtomicU64::new(0),
        });
        tokio::spawn(reap_idle(Arc::downgrade(&broker)));
        broker
    }

    pub async fn open(&self, req: OpenRequest) -> Result<OpenOutcome, SessionError> {
        match req.mode {
            SessionMode::Shared => {
                // Draining (REQ-19): a pending reservation stops new shared
                // sessions; existing ones finish naturally.
                if let Some(pending) = &*self.reservation.lock().unwrap() {
                    if pending.fulfilled.is_none() {
                        return Err(SessionError::Draining(pending.request.username.clone()));
                    }
                }
                Ok(OpenOutcome::Session(self.open_now(req).await?))
            }
            SessionMode::Dedicated => {
                if !self.cfg.allow_dedicated {
                    return Err(SessionError::DedicatedDisabled);
                }
                if self.sessions.lock().unwrap().is_empty()
                    && self.reservation.lock().unwrap().is_none()
                {
                    return Ok(OpenOutcome::Session(self.open_now(req).await?));
                }
                let mut slot = self.reservation.lock().unwrap();
                if let Some(existing) = &*slot {
                    // One reservation per engine; a fulfilled record frees the
                    // slot (its holder has their session — a new request starts
                    // the next drain when they release).
                    if existing.fulfilled.is_none() {
                        return Err(SessionError::ReservationHeld(
                            existing.request.username.clone(),
                        ));
                    }
                }
                let view = ReservationView {
                    username: req.username.clone(),
                    waited_secs: 0,
                    notified: false,
                };
                tracing::info!(user = %req.username, "dedicated reservation placed; engine draining");
                *slot = Some(PendingReservation {
                    request: req,
                    requested_at: Instant::now(),
                    notified: false,
                    fulfilled: None,
                });
                Ok(OpenOutcome::Reserved(view))
            }
        }
    }

    /// The immediate path: admission + spawn (both shared and empty-engine dedicated).
    async fn open_now(&self, req: OpenRequest) -> Result<SessionInfo, SessionError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let spec = SessionSpec {
            user: req.username.clone(),
            uid: req.uid,
            gid: req.gid,
            mode: req.mode,
            memory_limit_bytes: req.memory_limit_bytes,
        };
        self.admission.lock().unwrap().admit(id, &spec)?;

        match self.spawn_kernel(id, &req).await {
            Ok(entry) => {
                let info = entry.info.clone();
                self.sessions.lock().unwrap().insert(id, Arc::new(entry));
                tracing::info!(session = id, user = %info.username, uid = info.uid, pid = info.pid, "session opened");
                Ok(info)
            }
            Err(err) => {
                self.admission.lock().unwrap().release(id);
                Err(err)
            }
        }
    }

    /// The drain completes: an empty engine with a pending reservation starts the
    /// dedicated session. Called after every close (explicit or idle-reaped).
    async fn try_fulfill(&self) {
        let request = {
            let slot = self.reservation.lock().unwrap();
            match &*slot {
                Some(p) if p.fulfilled.is_none() && self.sessions.lock().unwrap().is_empty() => {
                    Some(p.request.clone())
                }
                _ => None,
            }
        };
        let Some(request) = request else { return };
        match self.open_now(request).await {
            Ok(info) => {
                tracing::info!(session = info.id, user = %info.username, "drain complete; dedicated session started");
                if let Some(p) = self.reservation.lock().unwrap().as_mut() {
                    p.fulfilled = Some(info);
                }
            }
            Err(err) => {
                tracing::error!(%err, "fulfilling dedicated reservation failed; reservation cleared");
                *self.reservation.lock().unwrap() = None;
            }
        }
    }

    /// Pending/ready state for the UI and the API ("none" when no reservation).
    pub fn reservation_status(&self) -> Option<(ReservationView, Option<SessionInfo>)> {
        let mut slot = self.reservation.lock().unwrap();
        let pending = slot.as_mut()?;
        // REQ-19: after the configured wait, the requester gets notified.
        if pending.fulfilled.is_none()
            && !pending.notified
            && pending.requested_at.elapsed() >= self.cfg.drain_notify
        {
            pending.notified = true;
            tracing::warn!(user = %pending.request.username, "drain still waiting; requester notified");
        }
        Some((
            ReservationView {
                username: pending.request.username.clone(),
                waited_secs: pending.requested_at.elapsed().as_secs(),
                notified: pending.notified,
            },
            pending.fulfilled.clone(),
        ))
    }

    /// Cancel a pending reservation (requester or admin); a fulfilled one is a
    /// live session and closes through the normal path instead.
    pub fn cancel_reservation(&self) -> bool {
        let mut slot = self.reservation.lock().unwrap();
        match &*slot {
            Some(p) if p.fulfilled.is_none() => {
                tracing::info!(user = %p.request.username, "reservation cancelled; drain ends");
                *slot = None;
                true
            }
            _ => false,
        }
    }

    pub fn state(&self) -> EngineState {
        if let Some(p) = &*self.reservation.lock().unwrap() {
            if p.fulfilled.is_none() {
                return EngineState::Draining(p.request.username.clone());
            }
        }
        let sessions = self.sessions.lock().unwrap();
        if let Some(dedicated) = sessions
            .values()
            .find(|e| e.info.mode == SessionMode::Dedicated)
        {
            return EngineState::Dedicated(dedicated.info.username.clone());
        }
        match sessions.len() {
            0 => EngineState::Available,
            n => EngineState::InUse(n),
        }
    }

    async fn spawn_kernel(&self, id: u64, req: &OpenRequest) -> Result<SessionEntry, SessionError> {
        let kernel = |e: String| SessionError::Kernel(e);
        let mut cmd = Command::new(&self.cfg.kernel);
        cmd.env_clear()
            // The miniforge `pebbles` env first: sessions get the Python/R/Jupyter
            // runtimes and the bundled scientific stack (REQ-51/52).
            .env(
                "PATH",
                "/opt/conda/envs/pebbles/bin:/opt/conda/bin:/usr/local/bin:/usr/bin:/bin",
            )
            .env("HOME", &req.home)
            .env("USER", &req.username)
            .env("LOGNAME", &req.username)
            // env_clear() above also dropped the locale: without it R (and any
            // non-Python tool the session runs) falls back to the C/ASCII locale
            // and mangles non-ASCII data. C.UTF-8 is always compiled into glibc.
            .env("LANG", "C.UTF-8")
            .env("LC_ALL", "C.UTF-8")
            .env(
                "PEBBLES_SESSION_MEMORY_BYTES",
                req.memory_limit_bytes.to_string(),
            )
            .current_dir(&req.home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        // Become the session user; skipped when already that user (dev/test runs).
        // NOT Command::uid/gid: those drop supplementary groups, which would make
        // every group grant (REQ-13) invisible to the session. Order matters:
        // setgid → initgroups → setuid, while still root.
        if req.uid != unsafe { libc::geteuid() } as u32 {
            let user = std::ffi::CString::new(req.username.as_str())
                .map_err(|_| SessionError::Kernel("username contains a NUL byte".to_string()))?;
            let (uid, gid) = (req.uid, req.gid);
            unsafe {
                cmd.pre_exec(move || {
                    if libc::setgid(gid) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    if libc::initgroups(user.as_ptr(), gid as _) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    if libc::setuid(uid) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
        }
        let mut child = cmd.spawn().map_err(|e| kernel(e.to_string()))?;
        let stdin = child.stdin.take().expect("piped stdin");
        let mut stdout = BufReader::new(child.stdout.take().expect("piped stdout")).lines();

        let hello_line = tokio::time::timeout(HANDSHAKE_TIMEOUT, stdout.next_line())
            .await
            .map_err(|_| SessionError::Handshake("timed out".into()))?
            .map_err(|e| SessionError::Handshake(e.to_string()))?
            .ok_or_else(|| SessionError::Handshake("kernel exited before hello".into()))?;
        let hello: Value = serde_json::from_str(&hello_line)
            .map_err(|e| SessionError::Handshake(format!("bad hello: {e}")))?;

        // The identity model's tripwire: the kernel reports the uid it actually has.
        let actual_uid = hello["uid"].as_u64().unwrap_or(u64::MAX);
        if actual_uid != u64::from(req.uid) {
            let _ = child.start_kill();
            return Err(SessionError::Handshake(format!(
                "kernel runs as uid {actual_uid}, expected {}",
                req.uid
            )));
        }

        let pid = child.id().ok_or_else(|| kernel("no pid".into()))?;
        Ok(SessionEntry {
            info: SessionInfo {
                id,
                username: req.username.clone(),
                uid: req.uid,
                gid: req.gid,
                pid,
                mode: req.mode,
                memory_limit_bytes: req.memory_limit_bytes,
            },
            last_used: StdMutex::new(Instant::now()),
            io: Arc::new(Mutex::new(SessionIo {
                stdin,
                stdout,
                child,
            })),
        })
    }

    /// Send one request line to the session's kernel and await one response line.
    pub async fn exec(&self, id: u64, payload: Value) -> Result<Value, SessionError> {
        let entry = self
            .sessions
            .lock()
            .unwrap()
            .get(&id)
            .cloned()
            .ok_or(SessionError::NotFound(id))?;
        let mut io = entry.io.lock().await;
        let line =
            serde_json::to_string(&payload).map_err(|e| SessionError::Kernel(e.to_string()))?;
        io.stdin
            .write_all(format!("{line}\n").as_bytes())
            .await
            .map_err(|e| SessionError::Kernel(e.to_string()))?;
        let reply = tokio::time::timeout(EXEC_TIMEOUT, io.stdout.next_line())
            .await
            .map_err(|_| SessionError::Kernel("kernel timed out".into()))?
            .map_err(|e| SessionError::Kernel(e.to_string()))?
            .ok_or_else(|| SessionError::Kernel("kernel closed the session".into()))?;
        *entry.last_used.lock().unwrap() = Instant::now();
        serde_json::from_str(&reply).map_err(|e| SessionError::Kernel(format!("bad reply: {e}")))
    }

    pub async fn close(&self, id: u64) -> Result<(), SessionError> {
        let entry = self
            .sessions
            .lock()
            .unwrap()
            .remove(&id)
            .ok_or(SessionError::NotFound(id))?;
        self.admission.lock().unwrap().release(id);
        let mut io = entry.io.lock().await;
        let _ = io.child.start_kill();
        let _ = io.child.wait().await;
        drop(io);
        tracing::info!(session = id, "session closed");
        // A closing dedicated session releases its reservation record.
        {
            let mut slot = self.reservation.lock().unwrap();
            if slot
                .as_ref()
                .and_then(|p| p.fulfilled.as_ref())
                .is_some_and(|s| s.id == id)
            {
                *slot = None;
            }
        }
        self.try_fulfill().await;
        Ok(())
    }

    pub fn list(&self) -> Vec<SessionInfo> {
        let mut infos: Vec<_> = self
            .sessions
            .lock()
            .unwrap()
            .values()
            .map(|e| e.info.clone())
            .collect();
        infos.sort_by_key(|i| i.id);
        infos
    }

    fn idle_ids(&self) -> Vec<u64> {
        let cutoff = self.cfg.idle_timeout;
        self.sessions
            .lock()
            .unwrap()
            .values()
            .filter(|e| e.last_used.lock().unwrap().elapsed() > cutoff)
            .map(|e| e.info.id)
            .collect()
    }
}

async fn reap_idle(broker: std::sync::Weak<Broker>) {
    loop {
        tokio::time::sleep(Duration::from_secs(60)).await;
        let Some(broker) = broker.upgrade() else {
            return;
        };
        for id in broker.idle_ids() {
            tracing::info!(session = id, "closing idle session");
            let _ = broker.close(id).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stand-in kernel honouring the protocol: hello with its real uid, then one
    /// JSON reply per request line.
    fn stub_kernel(dir: &std::path::Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("stub-kernel.sh");
        std::fs::write(
            &path,
            "#!/bin/sh\n\
             echo \"{\\\"kernel\\\":\\\"stub\\\",\\\"proto\\\":1,\\\"uid\\\":$(id -u),\\\"gid\\\":$(id -g)}\"\n\
             while read line; do echo '{\"id\":0,\"ok\":true}'; done\n",
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    fn request(dir: &std::path::Path, mem: u64) -> OpenRequest {
        OpenRequest {
            username: "me".into(),
            uid: unsafe { libc::getuid() },
            gid: unsafe { libc::getgid() },
            home: dir.display().to_string(),
            mode: SessionMode::Shared,
            memory_limit_bytes: mem,
        }
    }

    fn test_broker(dir: &std::path::Path) -> Arc<Broker> {
        Broker::start(BrokerConfig {
            kernel: stub_kernel(dir),
            engine_memory_bytes: 100,
            max_sessions: 4,
            idle_timeout: Duration::from_secs(3600),
            allow_dedicated: true,
            drain_notify: Duration::from_secs(900),
        })
    }

    fn session(outcome: OpenOutcome) -> SessionInfo {
        match outcome {
            OpenOutcome::Session(info) => info,
            OpenOutcome::Reserved(_) => panic!("expected a live session, got a reservation"),
        }
    }

    #[tokio::test]
    async fn open_exec_close_round_trip_and_admission_release() {
        let dir = tempfile::tempdir().unwrap();
        let broker = test_broker(dir.path());

        let info = session(broker.open(request(dir.path(), 60)).await.unwrap());
        assert_eq!(info.id, 1);
        assert_eq!(broker.list().len(), 1);
        assert_eq!(broker.state(), EngineState::InUse(1));

        let reply = broker
            .exec(info.id, serde_json::json!({"id": 1, "op": "ping"}))
            .await
            .unwrap();
        assert_eq!(reply["ok"], true);

        // REQ-20 across the broker: a second 60-byte session exceeds the 100-byte
        // engine, and closing the first frees its memory.
        let refused = broker.open(request(dir.path(), 60)).await;
        assert!(matches!(
            refused,
            Err(SessionError::Admission(
                AdmissionError::MemoryExceeded { .. }
            ))
        ));
        broker.close(info.id).await.unwrap();
        assert!(broker.open(request(dir.path(), 60)).await.is_ok());
    }

    #[tokio::test]
    async fn exec_on_unknown_session_is_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let broker = test_broker(dir.path());
        assert!(matches!(
            broker.exec(42, serde_json::json!({})).await,
            Err(SessionError::NotFound(42))
        ));
    }

    #[tokio::test]
    async fn dedicated_drains_never_refuses_and_fulfills_on_empty() {
        let dir = tempfile::tempdir().unwrap();
        let broker = test_broker(dir.path());

        let shared = session(broker.open(request(dir.path(), 30)).await.unwrap());

        // Dedicated on a busy engine: a reservation, not an error (REQ-19).
        let dedicated = OpenRequest {
            username: "me".into(),
            mode: SessionMode::Dedicated,
            ..request(dir.path(), 0)
        };
        assert!(matches!(
            broker.open(dedicated.clone()).await.unwrap(),
            OpenOutcome::Reserved(_)
        ));
        assert_eq!(broker.state(), EngineState::Draining("me".into()));

        // No new shared sessions during the drain…
        assert!(matches!(
            broker.open(request(dir.path(), 10)).await,
            Err(SessionError::Draining(_))
        ));
        // …and only one reservation per engine.
        assert!(matches!(
            broker.open(dedicated).await,
            Err(SessionError::ReservationHeld(_))
        ));

        // The last shared session closing completes the drain.
        broker.close(shared.id).await.unwrap();
        let (view, ready) = broker.reservation_status().unwrap();
        assert_eq!(view.username, "me");
        let ready = ready.expect("dedicated session should have started");
        assert!(matches!(broker.state(), EngineState::Dedicated(_)));

        // Closing the dedicated session clears the record entirely.
        broker.close(ready.id).await.unwrap();
        assert!(broker.reservation_status().is_none());
        assert_eq!(broker.state(), EngineState::Available);
    }

    #[tokio::test]
    async fn pending_reservations_cancel_cleanly() {
        let dir = tempfile::tempdir().unwrap();
        let broker = test_broker(dir.path());
        let shared = session(broker.open(request(dir.path(), 30)).await.unwrap());
        let dedicated = OpenRequest {
            mode: SessionMode::Dedicated,
            ..request(dir.path(), 0)
        };
        assert!(matches!(
            broker.open(dedicated).await.unwrap(),
            OpenOutcome::Reserved(_)
        ));
        assert!(broker.cancel_reservation());
        assert!(broker.reservation_status().is_none());
        // Shared sessions may start again once the drain is cancelled.
        assert!(broker.open(request(dir.path(), 10)).await.is_ok());
        broker.close(shared.id).await.unwrap();
    }
}
