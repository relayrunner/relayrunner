//! Runs one job in a slot's copy of actions/runner. A port of hostLauncher + runJob in
//! apps/cli/job.ts, without CPU/memory sampling.

use crate::events;
use crate::jit_config;
use crate::protocol::{JobState, JobUpdate};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

const JOB_STATE: [&str; 4] = ["_work", ".runner", ".credentials", ".credentials_rsaparams"];
const RUNNER_ENV: [&str; 8] = [
    "HOME", "USER", "LOGNAME", "PATH", "LANG", "LC_ALL", "TMPDIR", "SHELL",
];

/// Runs the job and reports each update. Returns once the runner is done.
pub async fn run(
    dir: PathBuf,
    slot: u32,
    route_id: String,
    jit_config: String,
    report: impl Fn(JobUpdate),
) {
    let update = |state, message: Option<String>| JobUpdate {
        route_id: route_id.clone(),
        state,
        message,
    };
    let target = match jit_config::check(&jit_config, &route_id) {
        Ok(target) => target,
        Err(reason) => {
            report(update(
                JobState::Failed,
                Some(format!("Refused the job's runner config: {reason}.")),
            ));
            return;
        }
    };
    if let Some(repo) = target {
        events::emit(
            "job-repo",
            serde_json::json!({ "routeId": route_id, "repo": repo }),
        );
    }

    let lock = dir.join("job.lock");
    if !take_lock(&lock) {
        let message = format!("Another job is using the runner in {}.", dir.display());
        report(update(JobState::Failed, Some(message)));
        return;
    }
    clean(&dir);

    let mut command = Command::new(dir.join("run.sh"));
    command
        .args(["--jitconfig", &jit_config])
        .current_dir(&dir)
        .env_clear()
        .envs(
            RUNNER_ENV
                .iter()
                .filter_map(|k| std::env::var_os(k).map(|v| (k, v))),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let result = match command.spawn() {
        Err(e) => update(
            JobState::Failed,
            Some(format!("Could not start the runner: {e}")),
        ),
        Ok(mut child) => {
            report(update(JobState::Started, None));
            // The runner's output goes to stderr with the slot in front, like the TS CLI's.
            let prefix = format!("[slot {slot}] ");
            let out = child.stdout.take().map(|s| forward(s, prefix.clone()));
            let err = child.stderr.take().map(|s| forward(s, prefix));
            let status = child.wait().await;
            for task in [out, err].into_iter().flatten() {
                let _ = task.await;
            }
            match status {
                Ok(s) if s.success() => update(JobState::Finished, None),
                Ok(s) => {
                    use std::os::unix::process::ExitStatusExt;
                    let message = match s.signal() {
                        Some(sig) => format!("The runner was stopped by signal {sig}"),
                        None => format!("The runner exited with {}", s.code().unwrap_or(-1)),
                    };
                    update(JobState::Failed, Some(message))
                }
                Err(e) => update(JobState::Failed, Some(e.to_string())),
            }
        }
    };
    clean(&dir);
    let _ = std::fs::remove_file(&lock);
    report(result);
}

fn forward<R: tokio::io::AsyncRead + Unpin + Send + 'static>(
    stream: R,
    prefix: String,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stream).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            eprintln!("{prefix}{line}");
        }
    })
}

fn clean(dir: &Path) {
    for name in JOB_STATE {
        let path = dir.join(name);
        let _ = std::fs::remove_dir_all(&path).or_else(|_| std::fs::remove_file(&path));
    }
}

/// A symlink to our pid, the same lock the TS CLI takes, so the two never share a slot.
pub fn take_lock(lock: &Path) -> bool {
    for _ in 0..2 {
        match std::os::unix::fs::symlink(std::process::id().to_string(), lock) {
            Ok(()) => return true,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let holder = std::fs::read_link(lock)
                    .ok()
                    .and_then(|p| p.to_str()?.parse::<i32>().ok());
                if holder.is_some_and(alive) {
                    return false;
                }
                let _ = std::fs::remove_file(lock);
            }
            Err(_) => return false,
        }
    }
    false
}

fn alive(pid: i32) -> bool {
    // kill(pid, 0) without libc: `kill -0` is everywhere this runs.
    pid > 0
        && std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
}
