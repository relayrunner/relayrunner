//! Spike: `relayrunner connect [--events] [--concurrency N]` in Rust. It reads the sign-in and the
//! runner the TypeScript CLI set up in ~/.relayrunner, so run `npx relayrunner connect` once first.
//! Not ported: login, installing or updating the runner, VMs, usage sampling, device details, and
//! every other command.

mod connection;
mod credentials;
mod events;
mod jit_config;
mod job;
mod protocol;

use serde_json::json;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use tokio::io::AsyncBufReadExt;
use tokio::sync::watch;

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn fail(code: &str, message: &str) -> ExitCode {
    events::emit("error", json!({ "code": code, "message": message }));
    eprintln!("{message}");
    ExitCode::FAILURE
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--version") {
        println!("{VERSION}");
        return ExitCode::SUCCESS;
    }
    if args.first().map(String::as_str) != Some("connect") {
        eprintln!("usage: relayrunner connect [--events] [--concurrency N]");
        return ExitCode::from(2);
    }
    let mut slots = 1;
    let mut it = args.iter().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--events" => events::start(),
            "--concurrency" => match it
                .next()
                .and_then(|n| n.parse::<u32>().ok())
                .filter(|n| (1..=1000).contains(n))
            {
                Some(n) => slots = n,
                None => {
                    return fail(
                        "INVALID_ARGUMENT",
                        "--concurrency takes a whole number from 1 to 1000.",
                    );
                }
            },
            // The app passes these; the spike ignores them.
            "--share" | "--cpus" | "--memory" => {
                it.next();
            }
            "--macos" | "--no-isolated" | "--local-network" | "--yes" => {}
            other => return fail("INVALID_ARGUMENT", &format!("Unknown option {other}.")),
        }
    }

    let credentials = match credentials::read() {
        Ok(Some(c)) => c,
        Ok(None) => {
            return fail(
                "NOT_SIGNED_IN",
                "Sign in first with `npx relayrunner connect`.",
            );
        }
        Err(e) => return fail("CREDENTIALS_UNREADABLE", &e.to_string()),
    };
    let home = credentials::home();
    let lock = home.join("connect.lock");
    if !job::take_lock(&lock) {
        return fail(
            "ALREADY_CONNECTED",
            "`relayrunner connect` is already running on this computer.",
        );
    }
    let Some((runner_version, runner_dir)) = installed_runner(&home.join("runner")) else {
        let _ = std::fs::remove_file(&lock);
        return fail(
            "RUNNER_MISSING",
            "No runner installed. Run `npx relayrunner connect` once first.",
        );
    };
    let slot_dirs = match ensure_slots(&runner_dir, slots) {
        Ok(dirs) => dirs,
        Err(e) => {
            let _ = std::fs::remove_file(&lock);
            return fail("SLOT_COPY_FAILED", &e.to_string());
        }
    };

    events::emit(
        "machine",
        json!({ "id": credentials.machine.id, "name": credentials.machine.name, "server": credentials.server }),
    );
    events::log(&format!(
        "{} is going online at {} with runner {runner_version}.",
        credentials.machine.name, credentials.server
    ));

    let (stop_tx, stop_rx) = watch::channel(false);
    // Ctrl-C (or SIGINT to the group) goes offline; a second one exits on the spot.
    let sigint_stop = stop_tx.clone();
    tokio::spawn(async move {
        let mut sigint =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt()).unwrap();
        sigint.recv().await;
        let _ = sigint_stop.send(true);
        sigint.recv().await;
        std::process::exit(130);
    });
    if events::on() {
        tokio::spawn(read_commands(credentials.clone(), stop_tx.clone()));
    }

    let hello = protocol::Hello {
        machine_id: credentials.machine.id.clone(),
        os: if cfg!(target_os = "macos") {
            "macos"
        } else {
            "linux"
        },
        arch: if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "x64"
        },
        runner_version,
        cli_version: VERSION.into(),
        device: protocol::Device {
            kind: "unknown",
            cpu_cores: std::thread::available_parallelism()
                .ok()
                .map(|n| n.get() as u32),
            os_version: None,
        },
        rotates_token: true,
        slots,
    };
    let end = connection::run(connection::Options {
        credentials,
        hello,
        slot_dirs,
        user_agent: format!("relayrunner-cli/{VERSION}"),
        stop: stop_rx,
    })
    .await;
    let _ = std::fs::remove_file(&lock);

    let (reason, message) = match end {
        connection::End::Stopped => ("stopped", None),
        connection::End::Revoked => ("revoked", Some("This machine's sign-in was revoked.")),
        connection::End::Replaced => ("replaced", Some("Another `relayrunner connect` took over.")),
        connection::End::Rejected(ref m) => ("rejected", Some(m.as_str())),
    };
    let mut offline = json!({ "reason": reason });
    if let Some(message) = message {
        offline["message"] = message.into();
    }
    events::emit("offline", offline);
    events::log(message.unwrap_or("Offline."));
    // Exit here rather than return: the runtime would otherwise wait on the blocking read of
    // stdin before shutting down.
    std::process::exit(if reason == "stopped" { 0 } else { 1 })
}

/// `pause` and `resume` on stdin; closing stdin goes offline.
async fn read_commands(credentials: credentials::Credentials, stop: watch::Sender<bool>) {
    let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let word = line.trim().to_lowercase();
        if word.is_empty() {
            continue;
        }
        if word != "pause" && word != "resume" {
            events::emit(
                "error",
                json!({ "code": "UNKNOWN_COMMAND", "message": "Commands are `pause` and `resume`.", "command": line.trim() }),
            );
            continue;
        }
        let c = credentials.clone();
        let result = tokio::task::spawn_blocking(move || set_paused(&c, &word)).await;
        if let Ok(Err(message)) = result {
            events::emit(
                "error",
                json!({ "code": "PAUSE_FAILED", "message": message, "command": line.trim() }),
            );
        }
    }
    let _ = stop.send(true);
}

/// POST /api/machines/me/pause|resume. The gateway's `paused` message updates the state.
fn set_paused(credentials: &credentials::Credentials, action: &str) -> Result<(), String> {
    let url = format!(
        "{}/api/machines/me/{action}",
        credentials.server.trim_end_matches('/')
    );
    let current = credentials::read()
        .ok()
        .flatten()
        .map_or(credentials.token.clone(), |c| c.token);
    ureq::post(&url)
        .header("authorization", &format!("Bearer {current}"))
        .header("user-agent", &format!("relayrunner-cli/{VERSION}"))
        .send_empty()
        .map(|_| ())
        .map_err(|e| format!("couldn't {action} this machine: {e}"))
}

/// The newest <home>/runner/<version> holding run.sh.
fn installed_runner(dir: &Path) -> Option<(String, PathBuf)> {
    let parse = |v: &str| {
        v.split('.')
            .map(|p| p.parse::<u32>().ok())
            .collect::<Option<Vec<_>>>()
    };
    std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().join("run.sh").exists())
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            Some((parse(&name)?, name, e.path()))
        })
        .max_by(|a, b| a.0.cmp(&b.0))
        .map(|(_, name, path)| (name, path))
}

/// <runner>/slot-<n>, copied from the runner where missing (clones on APFS), as slots.ts does.
fn ensure_slots(runner: &Path, count: u32) -> std::io::Result<Vec<PathBuf>> {
    let mut dirs = Vec::new();
    for slot in 1..=count {
        let dir = runner.join(format!("slot-{slot}"));
        if !dir.join("run.sh").exists() {
            let temp = runner.join(format!(".slot-{slot}.{}", std::process::id()));
            std::fs::create_dir_all(&temp)?;
            let entries: Vec<PathBuf> = std::fs::read_dir(runner)?
                .filter_map(|e| e.ok())
                .filter(|e| {
                    let name = e.file_name();
                    let name = name.to_string_lossy();
                    !name.starts_with("slot-")
                        && !name.starts_with('.')
                        && name != "_work"
                        && name != "job.lock"
                })
                .map(|e| e.path())
                .collect();
            let clone = if cfg!(target_os = "macos") {
                "-cR"
            } else {
                "-R"
            };
            let status = std::process::Command::new("cp")
                .arg(clone)
                .args(&entries)
                .arg(&temp)
                .status()?;
            if !status.success() {
                let _ = std::fs::remove_dir_all(&temp);
                return Err(std::io::Error::other(format!(
                    "couldn't copy the runner into {}",
                    dir.display()
                )));
            }
            std::fs::rename(&temp, &dir)?;
        }
        dirs.push(dir);
    }
    Ok(dirs)
}
