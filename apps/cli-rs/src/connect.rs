//! `relayrunner connect`: signs in when needed, gets the runner (and the VMs) ready, and keeps the
//! machine online. A port of connectCommand and connectMachine in apps/cli/cli.ts. Not ported yet:
//! the interactive sharing question, the `init` offer, the CLI update notice, and the `p` key.

use crate::connection::{self, End, Report, Run, RunJob};
use crate::credentials::{self, Credentials};
use crate::error::Error;
use crate::events;
use crate::install::{self, Installed};
use crate::isolated::{self, Isolation, Wanted};
use crate::job::{self, Launcher};
use crate::login;
use crate::protocol::{Hello, JobState, JobUpdate, Place, VmSize};
use crate::share::{self, Share};
use crate::sys;
use serde_json::json;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::AsyncBufReadExt;
use tokio::sync::watch;

const DEFAULT_SERVER: &str = "https://app.relayrunner.app";
const RUNNER_CHECK: Duration = Duration::from_secs(6 * 60 * 60);
const BUSY_RETRY: Duration = Duration::from_secs(10 * 60);
const MAX_WAIT: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Default, Debug)]
pub struct Args {
    pub server: Option<String>,
    pub name: Option<String>,
    pub share: Option<String>,
    pub concurrency: Option<String>,
    pub isolated: Option<bool>,
    pub macos: bool,
    pub cpus: Option<String>,
    pub memory: Option<String>,
    pub image: Option<String>,
    pub local_network: bool,
    pub events: bool,
}

impl Args {
    pub fn parse(args: &[String]) -> Result<Args, Error> {
        let mut out = Args::default();
        let mut it = args.iter();
        while let Some(arg) = it.next() {
            let (flag, inline) = match arg.split_once('=') {
                Some((f, v)) if f.starts_with("--") => (f, Some(v.to_string())),
                _ => (arg.as_str(), None),
            };
            let mut value = || {
                inline
                    .clone()
                    .or_else(|| it.next().cloned())
                    .ok_or_else(|| Error::new("USAGE", format!("{flag} needs a value.")))
            };
            match flag {
                "--server" => out.server = Some(value()?),
                "--name" => out.name = Some(value()?),
                "--share" => out.share = Some(value()?),
                "--concurrency" => out.concurrency = Some(value()?),
                "--cpus" => out.cpus = Some(value()?),
                "--memory" => out.memory = Some(value()?),
                "--image" => out.image = Some(value()?),
                "--isolated" => out.isolated = Some(true),
                "--no-isolated" => out.isolated = Some(false),
                "--macos" => out.macos = true,
                "--local-network" => out.local_network = true,
                "--events" => out.events = true,
                other => {
                    return Err(Error::new(
                        "USAGE",
                        format!("Unknown option {other}. See `relayrunner connect --help`."),
                    ));
                }
            }
        }
        Ok(out)
    }
}

fn fail(error: &Error) {
    eprintln!("{}", error.message);
    events::emit(
        "error",
        json!({ "code": error.code, "message": error.message }),
    );
}

/// The number of jobs at once: --concurrency, or as many VMs of the asked size as fit, or 2 with
/// 8 or more cores.
fn concurrency(value: Option<&str>, size: Wanted, cores: u32, memory: u64) -> Result<u32, Error> {
    match value.filter(|v| !v.is_empty()) {
        Some(v) => v
            .trim()
            .parse::<u32>()
            .ok()
            .filter(|n| (1..=1000).contains(n))
            .ok_or_else(|| {
                Error::new(
                    "USAGE",
                    format!("--concurrency takes a whole number from 1 to 1000, not \"{v}\"."),
                )
            }),
        None => {
            Ok(isolated::slots_for(size, cores, memory).unwrap_or(if cores >= 8 { 2 } else { 1 }))
        }
    }
}

pub async fn command(args: Args) -> i32 {
    if args.events {
        events::start();
    }
    let cores = sys::cpu_count();
    let memory = sys::total_memory().await;
    let prepared =
        isolated::parse_size(args.cpus.as_deref(), args.memory.as_deref(), cores, memory).and_then(
            |size| {
                let slots = concurrency(args.concurrency.as_deref(), size, cores, memory)?;
                isolated::check_fits(size, slots, memory)?;
                Ok((size, slots))
            },
        );
    let (size, slots) = match prepared {
        Ok(p) => p,
        Err(e) => {
            fail(&e);
            return 1;
        }
    };
    let home = credentials::home();
    let _ = std::fs::create_dir_all(&home);
    let lock = home.join("connect.lock");
    if !job::take_lock(&lock) {
        let pid = job::lock_holder(&lock)
            .map(|p| format!(" (process {p})"))
            .unwrap_or_default();
        fail(&Error::new(
            "ALREADY_CONNECTED",
            format!(
                "`relayrunner connect` is already running on this computer{pid}. Stop that one first, or use it instead."
            ),
        ));
        return 1;
    }
    let code = loop {
        match connect_machine(&args, size, slots).await {
            Ok(Some(code)) => break code,
            // Signed out before coming online: sign in again.
            Ok(None) => continue,
            Err(e) => {
                fail(&e);
                break 1;
            }
        }
    };
    if job::lock_holder(&lock) == Some(std::process::id() as i32) {
        let _ = std::fs::remove_file(&lock);
    }
    code
}

/// What new jobs run on now. Jobs take what's current when they start, so switching to a new
/// runner never touches one that's running.
struct Current {
    runner_version: String,
    host: Vec<PathBuf>,
    vm: Option<Arc<Isolation>>,
    running: u32,
}

/// Ok(Some(exit code)) when done, Ok(None) to sign in again.
async fn connect_machine(args: &Args, size: Wanted, slots: u32) -> Result<Option<i32>, Error> {
    let share = share::arg(args.share.as_deref())?;
    let vm_flag = [
        ("macos", args.macos),
        ("image", args.image.is_some()),
        ("local-network", args.local_network),
    ]
    .into_iter()
    .find(|(_, on)| *on)
    .map(|(f, _)| f)
    .or(if size.cpus.is_some() {
        Some("cpus")
    } else if size.memory_gb.is_some() {
        Some("memory")
    } else {
        None
    });
    if let (Some(false), Some(flag)) = (args.isolated, vm_flag) {
        return Err(Error::new(
            "USAGE",
            format!("--{flag} doesn't go with --no-isolated."),
        ));
    }
    let (runner_os, arch) = install::platform()?;
    let host_os = if runner_os == "osx" { "macos" } else { "linux" };
    let asked = args.isolated == Some(true) || vm_flag.is_some();
    if asked && let Some(reason) = isolated::unsupported_reason().await {
        return Err(Error::new("ISOLATED_UNSUPPORTED", reason));
    }
    let state = if asked || args.isolated == Some(false) {
        None
    } else {
        Some(isolated::state().await)
    };
    let use_vms = asked || state == Some(isolated::State::Ready);
    // Jobs in VMs run on Linux. With --macos the Mac offers both.
    let (os, place) = match (use_vms, args.macos) {
        (false, _) => (host_os, None),
        (true, true) => (host_os, Some(Place { os: "linux", arch })),
        (true, false) => ("linux", None),
    };

    let mut saved =
        credentials::read().map_err(|e| Error::new("CREDENTIALS_UNREADABLE", e.to_string()))?;
    let requested = args
        .server
        .clone()
        .or_else(|| std::env::var("RELAYRUNNER_URL").ok())
        .filter(|s| !s.is_empty());
    let server = credentials::normalize_server(
        &requested
            .or_else(|| saved.as_ref().map(|c| c.server.clone()))
            .unwrap_or_else(|| DEFAULT_SERVER.into()),
    )?;
    if let Some(c) = &saved
        && c.server != server
    {
        events::log(&format!(
            "This machine is enrolled with {}, not {server}. Signing in again.",
            c.server
        ));
        saved = None;
    }
    let credentials = match saved {
        Some(c) => {
            events::log(&format!("Machine {} ({})", c.machine.name, c.server));
            if let Some(share) = share {
                apply_sharing(&c, share).await;
            }
            c
        }
        None => enroll(&server, args.name.clone(), (os, arch), share).await?,
    };
    events::emit(
        "machine",
        json!({ "id": credentials.machine.id, "name": credentials.machine.name, "server": credentials.server }),
    );

    let home = credentials::home();
    let runners = home.join("runner");
    let log = |line: &str| events::log(line);
    let on_host = !use_vms || args.macos;
    let current = Arc::new(Mutex::new(Current {
        runner_version: String::new(),
        host: Vec::new(),
        vm: None,
        running: 0,
    }));

    let firewall = use_vms && isolated::firewall_installed();
    let debug = use_vms.then(|| isolated::DebugLog::start(&home));
    let mut vm_size = None;
    if let Some(debug) = &debug {
        if firewall {
            log(if args.local_network {
                "The firewall on this Mac is on, so --local-network has no effect. Turn it off with `relayrunner firewall off`."
            } else {
                "The firewall on this Mac is on."
            });
        }
        let runner_version = if args.image.is_some() {
            String::from("custom")
        } else {
            let r = runners.clone();
            blocking(move || install::latest_version(&r, &|l| events::log(l))).await?
        };
        let isolation = isolated::prepare(isolated::Prepare {
            slots,
            image: args.image.clone(),
            local_network: args.local_network && !firewall,
            size,
            log: &log,
            debug: debug.clone(),
            home: home.clone(),
            runner_version,
            keep: Vec::new(),
        })
        .await?;
        log(&format!(
            "Each job runs in its own Linux VM with {} CPUs and {} GB of memory.",
            isolation.cpus, isolation.memory_gb
        ));
        if isolation.local_network {
            log("Jobs can reach this Mac and your local network.");
        }
        log(&format!(
            "If something goes wrong, {} has the details.",
            debug.path.display()
        ));
        if !args.macos {
            log(
                "Jobs run in a Linux VM on this Mac. To take macOS jobs too, run `relayrunner connect --macos`.",
            );
        }
        vm_size = Some(VmSize {
            cpus: isolation.cpus,
            memory_gb: isolation.memory_gb,
        });
        let mut now = current.lock().unwrap();
        if !args.macos {
            now.runner_version.clone_from(&isolation.runner_version);
        }
        now.vm = Some(Arc::new(isolation));
    }
    if on_host {
        let r = runners.clone();
        let runner = blocking(move || install::ensure(&r, &|l| events::log(l))).await?;
        use_runner(&current, &runner, slots).await?;
        if let Some(hint) = state.filter(|_| !use_vms).and_then(isolated::setup_hint) {
            log(&hint);
        }
        if args.macos {
            log(
                "Linux jobs run in a VM. macOS jobs run on this Mac itself, where they can read your files. Only take macOS jobs from repos you trust.",
            );
        } else if args.isolated == Some(false) {
            log(
                "Jobs run on this machine itself, where they can read your files. Only take jobs from repos you trust.",
            );
        }
    }
    log(&if slots == 1 {
        "Running 1 job at a time. Change with --concurrency.".to_string()
    } else {
        format!("Running up to {slots} jobs at once. Change with --concurrency.")
    });
    let device = crate::device::detect().await;

    let (stop_tx, stop_rx) = watch::channel(false);
    // An image given with --image brings its own runner, so the VMs keep it.
    let updater = (on_host || (use_vms && args.image.is_none())).then(|| {
        tokio::spawn(keep_runner_updated(UpdateContext {
            current: current.clone(),
            runners: runners.clone(),
            slots,
            on_host,
            vms: use_vms && args.image.is_none(),
            macos: args.macos,
            size,
            home: home.clone(),
            stop: stop_rx.clone(),
        }))
    });

    // Ctrl-C (or SIGINT to the group) goes offline and lets a running job's runner clean up; a
    // second one exits on the spot.
    let sigint_stop = stop_tx.clone();
    let signals = tokio::spawn(async move {
        let mut sigint = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
            .expect("SIGINT handler");
        sigint.recv().await;
        let _ = sigint_stop.send(true);
        sigint.recv().await;
        std::process::exit(130);
    });
    let commands = args
        .events
        .then(|| tokio::spawn(read_commands(credentials.clone(), stop_tx.clone())));

    let runner_version = {
        let c = current.clone();
        Arc::new(move || c.lock().unwrap().runner_version.clone())
    };
    let hello = Hello {
        machine_id: credentials.machine.id.clone(),
        os,
        arch,
        runner_version: runner_version(),
        cli_version: crate::VERSION.into(),
        device,
        rotates_token: true,
        slots,
        isolated: place,
        vm: vm_size,
    };
    let run_job: RunJob = {
        let current = current.clone();
        let isolated_only = use_vms && !args.macos;
        Arc::new(move |run: Run, slot: u32, report: Report| {
            let current = current.clone();
            Box::pin(async move {
                // A job sent for a VM never runs on this machine itself.
                let launcher = {
                    let now = current.lock().unwrap();
                    if run.isolated || isolated_only {
                        now.vm.clone().map(Launcher::Vm)
                    } else {
                        now.host.get(slot as usize - 1).cloned().map(Launcher::Host)
                    }
                };
                let Some(launcher) = launcher else {
                    report(JobUpdate {
                        route_id: run.route_id,
                        state: JobState::Failed,
                        message: Some("The job was sent for a VM, and this machine isn't running jobs in one.".into()),
                        usage: None,
                    });
                    return;
                };
                let (prefix, note) = if slots > 1 {
                    (format!("[slot {slot}] "), format!(" (slot {slot})"))
                } else {
                    (String::new(), String::new())
                };
                current.lock().unwrap().running += 1;
                job::run(launcher, run, prefix, report, note).await;
                current.lock().unwrap().running -= 1;
            })
        })
    };

    let end = connection::run(connection::Options {
        credentials: credentials.clone(),
        hello,
        slots,
        run_job,
        runner_version,
        user_agent: crate::USER_AGENT.clone(),
        stop: stop_rx,
    })
    .await;
    let _ = stop_tx.send(true);
    signals.abort();
    if let Some(u) = updater {
        u.abort();
    }
    if let Some(c) = commands {
        c.abort();
    }

    let (reason, message, code) = match &end {
        End::Stopped => ("stopped", None, 0),
        End::Revoked { .. } => ("revoked", None, 1),
        End::Replaced => ("replaced", None, 1),
        End::Rejected(m) => ("rejected", Some(m.clone()), 1),
    };
    let mut offline = json!({ "reason": reason });
    if let Some(m) = &message {
        offline["message"] = m.clone().into();
    }
    events::emit("offline", offline);
    match end {
        End::Stopped => events::log("Offline."),
        End::Revoked { online } => {
            credentials::delete();
            // A token that was already dead means someone is here to sign in. One revoked while
            // online may be unattended, so that one stops and says so.
            if !online {
                events::log(
                    "This machine was removed or its token is no longer valid. If you didn't remove it, another copy of its token may have signed in elsewhere: check the Runners page. Signing in again.",
                );
                return Ok(None);
            }
            eprintln!(
                "This machine was removed or its token is no longer valid. If you didn't remove it, another copy of its token may have signed in elsewhere: check the Runners page and revoke it if so."
            );
            eprintln!("Run `relayrunner connect` again to sign in.");
        }
        End::Replaced => {
            eprintln!("Another `relayrunner connect` signed in as this machine and took over.");
            eprintln!(
                "If that wasn't you, someone has this machine's token: revoke it at {}/runners, then run `relayrunner connect` to sign in again.",
                credentials.server
            );
        }
        End::Rejected(m) => {
            eprintln!("The gateway rejected this CLI: {m}");
            eprintln!("Update it with `npx relayrunner@latest connect`.");
        }
    }
    Ok(Some(code))
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, Error> + Send + 'static,
) -> Result<T, Error> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| Error::new("INTERNAL", e.to_string()))?
}

async fn use_runner(
    current: &Arc<Mutex<Current>>,
    runner: &Installed,
    slots: u32,
) -> Result<(), Error> {
    let r = runner.clone();
    let dirs = blocking(move || install::ensure_slots(&r, slots, &|l| events::log(l))).await?;
    let mut now = current.lock().unwrap();
    now.host = dirs;
    now.runner_version.clone_from(&runner.version);
    Ok(())
}

/// Signs in through the browser, saves the token, and sets sharing when --share says.
async fn enroll(
    server: &str,
    name: Option<String>,
    platform: (&'static str, &'static str),
    share: Option<Share>,
) -> Result<Credentials, Error> {
    let name = match name.filter(|n| !n.is_empty()) {
        Some(n) => n,
        None => login::default_machine_name().await,
    };
    let server = server.to_string();
    let signed_in = blocking(move || {
        login::login(&server, &name, platform, |url, code| {
            events::log(&format!(
                "Sign in: {url}\nConfirm the code {code} matches the one in your browser."
            ));
            events::emit("sign-in", json!({ "url": url, "code": code }));
            login::open_browser(url);
            events::log("Waiting for approval in the browser…");
        })
    })
    .await?;
    let credentials = signed_in.credentials;
    credentials::save(&credentials)
        .map_err(|e| Error::new("CREDENTIALS_UNWRITABLE", e.to_string()))?;
    events::log(&format!(
        "Enrolled as {}. Token saved to {}.",
        credentials.machine.name,
        credentials::path_display()
    ));
    let names: Vec<&str> = signed_in
        .workspaces
        .iter()
        .map(|w| w.name.as_str())
        .collect();
    if !names.is_empty() {
        events::log(&format!(
            "Runs jobs in {}.\nChange with: relayrunner workspaces",
            names.join(", ")
        ));
    }
    if let Some(share) = share {
        apply_sharing(&credentials, share).await;
    } else if signed_in
        .workspaces
        .iter()
        .any(|w| w.member_count.unwrap_or(0) > 1)
    {
        events::log(
            "Only jobs you started run here. `relayrunner share anyone` lets teammates' jobs run here too.",
        );
    }
    Ok(credentials)
}

/// Best effort while connecting: a machine that couldn't change its sharing still connects.
async fn apply_sharing(credentials: &Credentials, share: Share) {
    let c = credentials.clone();
    match tokio::task::spawn_blocking(move || share::set(&c, share)).await {
        Ok(share::Outcome::Ok(now)) => events::log(&format!(
            "Sharing: {}: {}",
            now.choice(),
            now.meaning("your workspaces")
        )),
        Ok(share::Outcome::Failed(reason)) => events::log(&format!(
            "Couldn't set sharing: {reason}. Run `relayrunner share {}` to try again.",
            share.choice()
        )),
        _ => {}
    }
}

/// `pause` and `resume` on stdin; closing stdin goes offline and lets a running job finish.
async fn read_commands(credentials: Credentials, stop: watch::Sender<bool>) {
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
        let w = word.clone();
        let result = tokio::task::spawn_blocking(move || {
            match crate::api::call_as_machine(&c, "POST", &format!("/api/machines/me/{w}"), None) {
                crate::api::Reply::Ok(_) | crate::api::Reply::Revoked => Ok(()),
                crate::api::Reply::Status(status, body) => {
                    Err(crate::api::failure_reason(&c.server, status, &body))
                }
                crate::api::Reply::Unreachable(reason) => Err(reason),
            }
        })
        .await;
        if let Ok(Err(reason)) = result {
            let message = format!("Couldn't {word}: {reason}.");
            eprintln!("{message}");
            events::emit(
                "error",
                json!({ "code": "PAUSE_FAILED", "message": message, "command": word }),
            );
        }
    }
    let _ = stop.send(true);
}

struct UpdateContext {
    current: Arc<Mutex<Current>>,
    runners: PathBuf,
    slots: u32,
    on_host: bool,
    vms: bool,
    macos: bool,
    size: Wanted,
    home: PathBuf,
    stop: watch::Receiver<bool>,
}

/// Every few hours, sets up a newer actions/runner between jobs: GitHub stops sending jobs to a
/// runner about 30 days after a newer release. A port of apps/cli/runner-update.ts.
async fn keep_runner_updated(ctx: UpdateContext) {
    let mut due = tokio::time::Instant::now() + RUNNER_CHECK;
    let mut wait = RUNNER_CHECK;
    loop {
        tokio::time::sleep(wait).await;
        if *ctx.stop.borrow() {
            return;
        }
        let running = ctx.current.lock().unwrap().running;
        if running > 0 && tokio::time::Instant::now().duration_since(due) < MAX_WAIT {
            wait = BUSY_RETRY;
            continue;
        }
        let r = ctx.runners.clone();
        let latest = blocking(move || install::latest_version(&r, &|_| {})).await;
        let current = ctx.current.lock().unwrap().runner_version.clone();
        if let Ok(version) = latest
            && install::is_newer(&version, &current)
        {
            events::log(&format!("Updating the runner to actions/runner {version}…"));
            match update(&ctx, &version).await {
                Ok(()) => events::log(&format!("Jobs now run on actions/runner {version}.")),
                Err(e) => events::log(&format!(
                    "Couldn't update the runner ({e}). Trying again later."
                )),
            }
        }
        due = tokio::time::Instant::now() + RUNNER_CHECK;
        wait = RUNNER_CHECK;
    }
}

async fn update(ctx: &UpdateContext, version: &str) -> Result<(), Error> {
    if ctx.vms {
        let old = ctx.current.lock().unwrap().vm.clone();
        if let Some(old) = old {
            let isolation = isolated::prepare(isolated::Prepare {
                slots: ctx.slots,
                image: None,
                local_network: old.local_network,
                size: ctx.size,
                log: &|l: &str| events::log(l),
                debug: old.debug.clone(),
                home: ctx.home.clone(),
                runner_version: version.to_string(),
                // Jobs may still be running from the old images.
                keep: vec![old.base.clone(), old.image.clone()],
            })
            .await?;
            let mut now = ctx.current.lock().unwrap();
            if !ctx.macos {
                now.runner_version = version.to_string();
            }
            now.vm = Some(Arc::new(isolation));
        }
    }
    if ctx.on_host {
        let (r, v) = (ctx.runners.clone(), version.to_string());
        let runner = blocking(move || install::install_version(&r, &v)).await?;
        use_runner(&ctx.current, &runner, ctx.slots).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_flags() {
        let args: Vec<String> = [
            "--events",
            "--concurrency=3",
            "--share",
            "anyone",
            "--no-isolated",
        ]
        .map(String::from)
        .into();
        let parsed = Args::parse(&args).unwrap();
        assert!(parsed.events);
        assert_eq!(parsed.concurrency.as_deref(), Some("3"));
        assert_eq!(parsed.share.as_deref(), Some("anyone"));
        assert_eq!(parsed.isolated, Some(false));
        assert!(Args::parse(&["--bogus".to_string()]).is_err());
        assert!(Args::parse(&["--server".to_string()]).is_err());
    }

    #[test]
    fn picks_concurrency() {
        let gb = 1u64 << 30;
        assert_eq!(concurrency(None, Wanted::default(), 8, 16 * gb).unwrap(), 2);
        assert_eq!(concurrency(None, Wanted::default(), 4, 16 * gb).unwrap(), 1);
        assert_eq!(
            concurrency(
                None,
                Wanted {
                    cpus: Some(2),
                    memory_gb: None
                },
                8,
                16 * gb
            )
            .unwrap(),
            4
        );
        assert_eq!(
            concurrency(Some("5"), Wanted::default(), 8, 16 * gb).unwrap(),
            5
        );
        assert!(concurrency(Some("0"), Wanted::default(), 8, 16 * gb).is_err());
    }
}
