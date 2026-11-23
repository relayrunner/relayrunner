//! Runs the job a `run` message hands the machine: on this machine in a slot's copy of
//! actions/runner, or in a VM.

use crate::connection::{Report, Run};
use crate::events;
use crate::history;
use crate::isolated::{self, Isolation};
use crate::jit_config;
use crate::protocol::{JobState, JobUpdate, JobUsage};
use crate::usage::{self, Source};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

const JOB_STATE: [&str; 4] = ["_work", ".runner", ".credentials", ".credentials_rsaparams"];
// Only what the runner needs, so the CLI's own secrets don't reach workflow steps.
const RUNNER_ENV: [&str; 8] = [
    "HOME", "USER", "LOGNAME", "PATH", "LANG", "LC_ALL", "TMPDIR", "SHELL",
];

/// Where a job's runner runs.
#[derive(Clone, Debug)]
pub enum Launcher {
    /// A slot's runner directory, holding run.sh.
    Host(PathBuf),
    Vm(Arc<Isolation>),
}

/// The runner's own name for the job and GitHub's result for it, once it prints them.
type RunnerResult = Arc<Mutex<Option<(String, String)>>>;

/// Runs the job and reports each update. `prefix` goes in front of each line of its output.
pub async fn run(
    launcher: Launcher,
    run: Run,
    slot: u32,
    prefix: String,
    report: Report,
    slot_note: String,
) {
    let route_id = run.route_id.clone();
    let update = |state, message: Option<String>, usage: Option<JobUsage>| JobUpdate {
        route_id: route_id.clone(),
        state,
        message,
        usage,
    };
    let mut repo = None;
    // Nothing runs on a config that points the runner anywhere but GitHub.
    match jit_config::check(&run.jit_config, &route_id) {
        Err(reason) => {
            report(update(
                JobState::Failed,
                Some(format!("Refused the job's runner config: {reason}.")),
                None,
            ));
            return;
        }
        Ok(Some(name)) => {
            events::log(&format!("Job {route_id}{slot_note} is from {name}"));
            events::emit(&events::Event::JobRepo {
                route_id: route_id.to_string(),
                repo: name.to_string(),
            });
            repo = Some(name.to_string());
        }
        Ok(None) => {}
    }

    let mut command;
    match &launcher {
        Launcher::Host(dir) => {
            if !take_lock(&dir.join("job.lock")) {
                let message = format!("Another job is using the runner in {}.", dir.display());
                report(update(JobState::Failed, Some(message), None));
                return;
            }
            clean(dir).await;
            command = Command::new(dir.join("run.sh"));
            command
                .args(["--jitconfig", &run.jit_config])
                .current_dir(dir);
        }
        Launcher::Vm(isolation) => {
            let args = isolated::run_args(&route_id, isolation);
            isolation
                .debug
                .write(&format!("$ container {}", args.join(" ")));
            command = Command::new(isolated::container_command());
            command.args(&args);
        }
    }
    command
        .env_clear()
        .envs(
            RUNNER_ENV
                .iter()
                .filter_map(|k| std::env::var_os(k).map(|v| (k, v))),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Launcher::Vm(_) = &launcher {
        command.env("RUNNER_JIT_CONFIG", &run.jit_config);
    }

    let runner_result: RunnerResult = Arc::default();
    let mut started = None;
    let (result, clean_exit) = match command.spawn() {
        Err(e) => (
            update(
                JobState::Failed,
                Some(format!("Could not start the runner: {e}")),
                None,
            ),
            false,
        ),
        Ok(mut child) => {
            report(update(JobState::Started, None, None));
            started = Some((
                events::now_iso(),
                history::now_ms(),
                std::time::Instant::now(),
            ));
            let source = match &launcher {
                Launcher::Host(_) => match child.id() {
                    Some(pid) => Some(Source::Tree {
                        pid,
                        cpus: crate::sys::cpu_count(),
                        memory_mb: (crate::sys::total_memory().await as f64 / 1024.0 / 1024.0)
                            .round() as u64,
                    }),
                    None => None,
                },
                Launcher::Vm(i) => Some(Source::Vm {
                    name: isolated::container_name(&route_id),
                    cpus: i.cpus,
                    memory_mb: u64::from(i.memory_gb) * 1024,
                }),
            };
            let sampler = source.map(usage::sample);
            let out = child.stdout.take().map(|s| {
                let watch = Some((route_id.clone(), runner_result.clone()));
                forward(s, prefix.clone(), false, watch)
            });
            let err = child.stderr.take().map(|s| forward(s, prefix, true, None));
            let status = child.wait().await;
            for task in [out, err].into_iter().flatten() {
                let _ = task.await;
            }
            let usage = match sampler {
                Some((stop, task)) => {
                    let _ = stop.send(());
                    task.await.ok().flatten()
                }
                None => None,
            };
            if let Launcher::Vm(i) = &launcher {
                i.debug.write(&format!(
                    "{}: exit {status:?}",
                    isolated::container_name(&route_id)
                ));
            }
            match status {
                Ok(s) if s.success() => (update(JobState::Finished, None, usage), true),
                Ok(s) => {
                    use std::os::unix::process::ExitStatusExt;
                    let message = match s.signal() {
                        Some(sig) => format!("The runner was stopped by {}", signal_name(sig)),
                        None => format!("The runner exited with {}", s.code().unwrap_or(-1)),
                    };
                    (update(JobState::Failed, Some(message), usage), false)
                }
                Err(e) => (update(JobState::Failed, Some(e.to_string()), usage), false),
            }
        }
    };

    match &launcher {
        Launcher::Host(dir) => {
            clean(dir).await;
            let _ = std::fs::remove_file(dir.join("job.lock"));
        }
        // `--rm` deletes the VM after a clean exit. Anything else may have left it behind.
        Launcher::Vm(i) if !clean_exit => isolated::cleanup(&route_id, i).await,
        Launcher::Vm(_) => {}
    }
    if let Some((started_at, started_at_ms, clock)) = started {
        let entry = history::Entry::from(history::Finished {
            route_id: &route_id,
            repo,
            job: run.job.as_ref(),
            runner_result: runner_result.lock().unwrap().take(),
            state: result.state.clone(),
            message: result.message.clone(),
            slot,
            started_at,
            started_at_ms,
            duration_ms: clock.elapsed().as_millis() as u64,
            usage: result.usage.clone(),
        });
        history::append(&history::path(), &entry);
        events::emit(&events::Event::JobEnd(entry));
    }
    report(result);
}

fn signal_name(sig: i32) -> String {
    match sig {
        libc::SIGINT => "SIGINT".into(),
        libc::SIGTERM => "SIGTERM".into(),
        libc::SIGKILL => "SIGKILL".into(),
        libc::SIGHUP => "SIGHUP".into(),
        other => format!("signal {other}"),
    }
}

/// The runner's output, line by line with `prefix`, to stderr when stdout carries events. On
/// stdout (`watch` set), the runner's line for how the job ended is kept for the history and
/// becomes a `job-result` event.
fn forward<R: tokio::io::AsyncRead + Unpin + Send + 'static>(
    stream: R,
    prefix: String,
    is_err: bool,
    watch: Option<(String, RunnerResult)>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stream).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some((route_id, kept)) = &watch
                && let Some((job, result)) = job_result(&line)
            {
                *kept.lock().unwrap() = Some((job.to_string(), result.to_string()));
                events::emit(&events::Event::JobResult {
                    route_id: route_id.to_string(),
                    job: job.to_string(),
                    result: result.to_string(),
                });
            }
            if is_err || events::on() {
                eprintln!("{prefix}{line}");
            } else {
                println!("{prefix}{line}");
            }
        }
    })
}

/// The job's name and result from the runner's last line for it, such as
/// `2026-11-18 01:02:03Z: Job test completed with result: Failed`. The result is GitHub's:
/// Succeeded, Failed, Canceled and so on.
fn job_result(line: &str) -> Option<(&str, &str)> {
    let (head, result) = line.rsplit_once(" completed with result: ")?;
    let (_, job) = head.split_once(": Job ")?;
    Some((job, result.trim()))
}

/// Off the runtime's thread: `_work` can hold a whole checkout and its build output.
async fn clean(dir: &Path) {
    let dir = dir.to_path_buf();
    let _ = tokio::task::spawn_blocking(move || {
        for name in JOB_STATE {
            let path = dir.join(name);
            let _ = std::fs::remove_dir_all(&path).or_else(|_| std::fs::remove_file(&path));
        }
    })
    .await;
}

/// A symlink to our pid, the same lock older (TypeScript) versions take. A lock left by a process
/// that has exited is taken over.
pub fn take_lock(lock: &Path) -> bool {
    for _ in 0..2 {
        match std::os::unix::fs::symlink(std::process::id().to_string(), lock) {
            Ok(()) => return true,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                if lock_holder(lock).is_some() {
                    return false;
                }
                let _ = std::fs::remove_file(lock);
            }
            Err(_) => return false,
        }
    }
    false
}

/// The pid of the live process holding a lock, or None.
pub fn lock_holder(lock: &Path) -> Option<i32> {
    let pid: i32 = std::fs::read_link(lock).ok()?.to_str()?.parse().ok()?;
    // SAFETY: kill with signal 0 only checks the process exists.
    let alive = pid > 0
        && (unsafe { libc::kill(pid, 0) } == 0
            || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM));
    alive.then_some(pid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_runners_job_result() {
        assert_eq!(
            job_result("2026-11-18 01:02:03Z: Job test completed with result: Failed"),
            Some(("test", "Failed"))
        );
        assert_eq!(
            job_result(
                "2026-11-18 01:02:03Z: Job build (macos, 18) completed with result: Succeeded"
            ),
            Some(("build (macos, 18)", "Succeeded"))
        );
        assert_eq!(job_result("2026-11-18 01:02:03Z: Running job: test"), None);
        assert_eq!(job_result("Step completed with result: Failed"), None);
    }

    #[test]
    fn locks_and_takes_over_stale_locks() {
        let dir = std::env::temp_dir().join(format!("rr-lock-{}", fastrand::u32(..)));
        std::fs::create_dir_all(&dir).unwrap();
        let lock = dir.join("job.lock");
        assert!(take_lock(&lock));
        assert_eq!(lock_holder(&lock), Some(std::process::id() as i32));
        assert!(!take_lock(&lock));
        std::fs::remove_file(&lock).unwrap();
        std::os::unix::fs::symlink("999999999", &lock).unwrap();
        assert!(take_lock(&lock));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
