//! Process supervision. `pebblesd` is PID 1 in the container ("supervisor mode"),
//! so it owns the lifecycle of every long-running service: spawn, restart with
//! backoff, and graceful SIGTERM fan-out on shutdown.
//!
//! Note on zombies: every supervised process is a direct child, which tokio reaps.
//! Re-parented grandchildren (a crashed service's workers) are not reaped yet; the
//! proper subreaper strategy lands with the session broker in M0.4, which must own
//! wait() semantics anyway.

use std::path::PathBuf;
use std::time::{Duration, Instant};
use tokio::process::{Child, Command};
use tokio::sync::watch;
use tokio::task::JoinHandle;

/// One command invocation: what to run and as whom.
#[derive(Debug, Clone)]
pub struct Exec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub envs: Vec<(String, String)>,
    /// uid/gid to run as; `None` keeps pebblesd's own (root in the container).
    pub run_as: Option<(u32, u32)>,
}

impl Exec {
    fn command(&self) -> Command {
        let mut cmd = Command::new(&self.program);
        cmd.args(&self.args).envs(self.envs.iter().cloned());
        if let Some((uid, gid)) = self.run_as {
            cmd.uid(uid).gid(gid);
        }
        cmd
    }
}

/// A supervised service: `pre` steps run to completion in order (e.g. initdb),
/// then `exec` is kept running until shutdown.
#[derive(Debug, Clone)]
pub struct ServiceSpec {
    pub name: String,
    pub pre: Vec<Exec>,
    pub exec: Exec,
}

/// Restart backoff: 2^attempt seconds, capped at 30.
pub fn backoff_secs(attempt: u32) -> u64 {
    (1u64 << attempt.min(5)).min(30)
}

/// If a child ran at least this long, its next crash restarts the backoff ladder.
const HEALTHY_RUN: Duration = Duration::from_secs(60);
const TERM_GRACE: Duration = Duration::from_secs(10);

pub struct Supervisor {
    shutdown: watch::Sender<bool>,
    tasks: Vec<JoinHandle<()>>,
}

impl Supervisor {
    pub fn start(specs: Vec<ServiceSpec>) -> Self {
        let (shutdown, _) = watch::channel(false);
        let tasks = specs
            .into_iter()
            .map(|spec| tokio::spawn(run_service(spec, shutdown.subscribe())))
            .collect();
        Self { shutdown, tasks }
    }

    /// SIGTERM every service, wait for exits (bounded), then return.
    pub async fn shutdown(self) {
        let _ = self.shutdown.send(true);
        for task in self.tasks {
            let _ = tokio::time::timeout(TERM_GRACE * 2, task).await;
        }
    }
}

async fn run_service(spec: ServiceSpec, mut shutdown: watch::Receiver<bool>) {
    for pre in &spec.pre {
        tracing::info!(service = %spec.name, step = %pre.program.display(), "running pre step");
        match pre.command().status().await {
            Ok(status) if status.success() => {}
            Ok(status) => {
                tracing::error!(service = %spec.name, %status, "pre step failed; service disabled");
                return;
            }
            Err(err) => {
                tracing::error!(service = %spec.name, %err, "pre step could not start; service disabled");
                return;
            }
        }
    }

    let mut attempt: u32 = 0;
    loop {
        if *shutdown.borrow() {
            return;
        }
        let started = Instant::now();
        let mut child = match spec.exec.command().spawn() {
            Ok(child) => child,
            Err(err) => {
                // A missing binary won't appear by retrying; leave a loud trail instead.
                tracing::error!(service = %spec.name, %err, "cannot spawn; service disabled");
                return;
            }
        };
        tracing::info!(service = %spec.name, pid = child.id(), "started");

        tokio::select! {
            status = child.wait() => {
                attempt = if started.elapsed() >= HEALTHY_RUN { 0 } else { attempt + 1 };
                let delay = backoff_secs(attempt);
                tracing::warn!(service = %spec.name, ?status, delay, "exited; restarting");
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(delay)) => {}
                    _ = shutdown.changed() => return,
                }
            }
            _ = shutdown.changed() => {
                terminate(&spec.name, &mut child).await;
                return;
            }
        }
    }
}

async fn terminate(name: &str, child: &mut Child) {
    if let Some(pid) = child.id() {
        tracing::info!(service = %name, pid, "sending SIGTERM");
        // SAFETY: signalling a pid we own and have not yet waited on.
        unsafe { libc::kill(pid as i32, libc::SIGTERM) };
    }
    if tokio::time::timeout(TERM_GRACE, child.wait())
        .await
        .is_err()
    {
        tracing::warn!(service = %name, "did not exit in time; killing");
        let _ = child.start_kill();
        let _ = child.wait().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_and_caps_at_thirty_seconds() {
        assert_eq!(backoff_secs(0), 1);
        assert_eq!(backoff_secs(1), 2);
        assert_eq!(backoff_secs(4), 16);
        assert_eq!(backoff_secs(5), 30);
        assert_eq!(backoff_secs(20), 30);
    }

    #[tokio::test]
    async fn oneshot_pre_failure_disables_the_service_cleanly() {
        let spec = ServiceSpec {
            name: "doomed".into(),
            pre: vec![Exec {
                program: "/bin/false".into(),
                args: vec![],
                envs: vec![],
                run_as: None,
            }],
            exec: Exec {
                program: "/bin/sleep".into(),
                args: vec!["60".into()],
                envs: vec![],
                run_as: None,
            },
        };
        let sup = Supervisor::start(vec![spec]);
        // The pre step fails fast; shutdown must return promptly with no child left.
        tokio::time::timeout(Duration::from_secs(5), sup.shutdown())
            .await
            .expect("shutdown hangs");
    }

    #[tokio::test]
    async fn shutdown_terminates_a_running_service() {
        let spec = ServiceSpec {
            name: "sleeper".into(),
            pre: vec![],
            exec: Exec {
                program: "/bin/sleep".into(),
                args: vec!["300".into()],
                envs: vec![],
                run_as: None,
            },
        };
        let sup = Supervisor::start(vec![spec]);
        tokio::time::sleep(Duration::from_millis(200)).await;
        tokio::time::timeout(Duration::from_secs(15), sup.shutdown())
            .await
            .expect("SIGTERM path hangs");
    }
}
