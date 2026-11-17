//! Isolated jobs: each job runs in its own Linux VM with Apple's `container` tool, from GitHub's
//! runner image with nothing of the Mac mounted. The start script and
//! Dockerfile match older (TypeScript) versions' byte for byte, so images they built are reused.

use crate::error::Error;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

const RUNNER_IMAGE: &str = "ghcr.io/actions/actions-runner";
const RELEASES: &str = "https://github.com/apple/container/releases";
pub const START_SCRIPT: &str = include_str!("start.sh");
const START_PATH: &str = "/usr/local/bin/relayrunner-start";
const GH_KEYRING: &str = "/usr/share/keyrings/githubcli-archive-keyring.gpg";
const TOOLS: &str = "build-essential pkg-config cmake python3-pip python3-venv python-is-python3 zip xz-utils zstd bzip2 wget rsync file gettext-base bc time git-lfs sqlite3 docker-compose-v2 netcat-openbsd iputils-ping dnsutils iproute2 libssl-dev gh";
const NO_DNS: i32 = 3;
/// What `relayrunner firewall on` installs.
pub const RULES_FILE: &str = "/etc/pf.anchors/app.relayrunner";
pub const DAEMON_FILE: &str = "/Library/LaunchDaemons/app.relayrunner.firewall.plist";

#[derive(Debug, Clone)]
pub struct Isolation {
    pub base: String,
    pub image: String,
    pub local_network: bool,
    pub debug: DebugLog,
    pub runner_version: String,
    pub cpus: u32,
    pub memory_gb: u32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum State {
    Ready,
    Stopped,
    Missing,
    Unsupported,
}

/// Why jobs can't run in VMs here, or None. Apple's tool needs Apple silicon and macOS 26
/// (Darwin 25).
pub async fn unsupported_reason() -> Option<&'static str> {
    if !cfg!(target_os = "macos") {
        return Some("Running jobs in VMs needs a Mac with Apple silicon and macOS 26 or later.");
    }
    if !cfg!(target_arch = "aarch64") {
        return Some(
            "Running jobs in VMs needs a Mac with Apple silicon. This one has an Intel chip.",
        );
    }
    let darwin = crate::sys::run("uname", &["-r"]).await.unwrap_or_default();
    let major: u32 = darwin
        .split('.')
        .next()
        .and_then(|m| m.parse().ok())
        .unwrap_or(0);
    (major < 25)
        .then_some("Running jobs in VMs needs macOS 26 or later. Update macOS, then try again.")
}

pub async fn state() -> State {
    if unsupported_reason().await.is_some() {
        return State::Unsupported;
    }
    match call(&["system", "status"], None, true).await.0 {
        None => State::Missing,
        Some(0) => State::Ready,
        Some(_) => State::Stopped,
    }
}

/// What `connect` says when jobs run on the Mac itself because VMs aren't set up.
pub fn setup_hint(state: State) -> Option<String> {
    let step = match state {
        State::Missing => format!(
            "install Apple's container tool from {RELEASES} and run `container system start`"
        ),
        State::Stopped => "run `container system start`".into(),
        _ => return None,
    };
    Some(format!(
        "Jobs run on this Mac itself, where they can read your files. To run each job in its own Linux VM, {step}."
    ))
}

pub fn firewall_installed() -> bool {
    [RULES_FILE, DAEMON_FILE]
        .iter()
        .all(|f| Path::new(f).exists())
}

/// A file recording what the VMs did, to share when something goes wrong. Never a job's output or
/// its JIT config. The home folder becomes `~`.
#[derive(Debug, Clone)]
pub struct DebugLog {
    pub path: PathBuf,
}

impl DebugLog {
    pub fn start(home: &Path) -> DebugLog {
        let log = DebugLog {
            path: home.join("isolated.log"),
        };
        let _ = std::fs::remove_file(&log.path);
        log.write(&format!(
            "relayrunner {} (rust), {} {}",
            crate::VERSION,
            std::env::consts::OS,
            std::env::consts::ARCH
        ));
        log
    }

    pub fn write(&self, text: &str) {
        let home = std::env::var("HOME").unwrap_or_default();
        let mut text = text.trim_end().to_string();
        if !home.is_empty() {
            text = text.replace(&home, "~");
        }
        let line = format!("{} {text}\n", crate::events::now_iso());
        use std::os::unix::fs::OpenOptionsExt;
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(&self.path)
        {
            let _ = file.write_all(line.as_bytes());
        }
    }
}

pub fn dockerfile(base: &str, tools: bool) -> String {
    let install = format!(
        r#"RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o {GH_KEYRING} \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by={GH_KEYRING}] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends {TOOLS} \
  && apt-get clean && rm -rf /var/lib/apt/lists/*
RUN node=$(ls -d /home/runner/externals/node[0-9]* 2>/dev/null | sort -V | tail -n 1) \
  && {{ [ -z "$node" ] || {{ ln -sf "$node"/bin/* /usr/local/bin/ \
    && echo prefix=/usr/local > "$node"/lib/node_modules/npm/npmrc \
    && mkdir -p /usr/local/lib/node_modules \
    && chown runner /usr/local/bin /usr/local/lib/node_modules; }}; }}
"#
    );
    format!(
        "FROM {base}\nUSER root\nRUN apt-get update && apt-get install -y --no-install-recommends iptables nftables && apt-get clean\n{}COPY --chmod=755 start.sh {START_PATH}\n",
        if tools { install.as_str() } else { "" }
    )
}

/// The job image's tag, which changes with the base image, the Dockerfile or the start script.
pub fn job_image(base: &str, tools: bool) -> String {
    let mut hash = Sha256::new();
    hash.update(dockerfile(base, tools));
    hash.update(START_SCRIPT);
    let hex = format!("{:x}", hash.finalize());
    format!("relayrunner-runner:{}", &hex[..12])
}

/// Each VM's size as asked for with --cpus and --memory.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Wanted {
    pub cpus: Option<u32>,
    pub memory_gb: Option<u32>,
}

pub fn parse_size(
    cpus: Option<&str>,
    memory: Option<&str>,
    cores: u32,
    memory_bytes: u64,
) -> Result<Wanted, Error> {
    let whole =
        |flag: &str, value: Option<&str>, most: u64, unit: &str| -> Result<Option<u32>, Error> {
            let Some(value) = value.filter(|v| !v.is_empty()) else {
                return Ok(None);
            };
            let n: u64 = value
                .trim()
                .parse()
                .ok()
                .filter(|n| *n >= 1)
                .ok_or_else(|| {
                    Error::new(
                        "USAGE",
                        format!("{flag} takes a whole number, not \"{value}\"."),
                    )
                })?;
            if n > most {
                return Err(Error::new(
                    "USAGE",
                    format!("{flag} {n} is more than this machine's {most} {unit}."),
                ));
            }
            Ok(Some(n as u32))
        };
    Ok(Wanted {
        cpus: whole("--cpus", cpus, u64::from(cores), "CPU cores")?,
        memory_gb: whole("--memory", memory, memory_bytes / (1 << 30), "GB of memory")?,
    })
}

/// How many jobs of that size fit when --concurrency doesn't say: in the cores and half the memory.
pub fn slots_for(size: Wanted, cores: u32, memory_bytes: u64) -> Option<u32> {
    if size.cpus.is_none() && size.memory_gb.is_none() {
        return None;
    }
    let gb = memory_bytes as f64 / f64::from(1u32 << 30);
    let by_cpu = size.cpus.map_or(u32::MAX, |c| cores / c);
    let by_memory = size
        .memory_gb
        .map_or(u32::MAX, |m| (gb / 2.0 / f64::from(m)).floor() as u32);
    Some(by_cpu.min(by_memory).max(1))
}

pub fn check_fits(size: Wanted, slots: u32, memory_bytes: u64) -> Result<(), Error> {
    let gb = memory_bytes / (1 << 30);
    match size.memory_gb {
        Some(m) if u64::from(m) * u64::from(slots) > gb => Err(Error::new(
            "USAGE",
            format!(
                "{slots} jobs with {m} GB each is more than this machine's {gb} GB of memory. Lower --concurrency or --memory."
            ),
        )),
        _ => Ok(()),
    }
}

/// Each VM's share: an even split of the cores, and of half the memory (2 to 16 GB), unless given.
pub fn vm_size(slots: u32, wanted: Wanted, cores: u32, memory_bytes: u64) -> (u32, u32) {
    let gb = memory_bytes as f64 / f64::from(1u32 << 30);
    (
        wanted.cpus.unwrap_or_else(|| (cores / slots).max(2)),
        wanted
            .memory_gb
            .unwrap_or_else(|| ((gb / 2.0 / f64::from(slots)).floor() as u32).clamp(2, 16)),
    )
}

pub fn dns_message(base: &str) -> String {
    format!(
        "Linux VMs on this Mac can't look up hostnames, though the Mac itself can.\nVPN or DNS filtering software often causes this, even when it's disconnected or its app is closed. Quit it fully, then run `relayrunner connect` again.\n\nTo check, this should print an address:\n  container run --rm {base} getent ahostsv4 github.com\n\nTo run jobs on the Mac without VMs for now, use `relayrunner connect --no-isolated`."
    )
}

pub struct Prepare<'a> {
    pub slots: u32,
    pub image: Option<String>,
    pub local_network: bool,
    pub size: Wanted,
    pub log: &'a (dyn Fn(&str) + Sync),
    pub debug: DebugLog,
    pub home: PathBuf,
    pub runner_version: String,
    /// Images jobs may still be running from, kept until the next update.
    pub keep: Vec<String>,
}

/// Checks Apple's container tool runs and gets the job image ready, so the first job doesn't wait.
pub async fn prepare(options: Prepare<'_>) -> Result<Isolation, Error> {
    let debug = Some(&options.debug);
    let fail = |code: &'static str, message: String| {
        Error::new(
            code,
            format!("{message} Details are in {}.", options.debug.path.display()),
        )
    };
    let (status, _) = call(&["system", "status"], debug, false).await;
    call(&["--version"], debug, false).await;
    match status {
        None => {
            return Err(Error::new(
                "ISOLATED_SETUP",
                format!(
                    "Running jobs in VMs needs Apple's container tool. Install it from {RELEASES}, then run `container system start`."
                ),
            ));
        }
        Some(0) => {}
        Some(_) => return Err(fail(
            "ISOLATED_SETUP",
            "Apple's container tool isn't running. Run `container system start`, then try again."
                .into(),
        )),
    }

    let base = options
        .image
        .clone()
        .unwrap_or_else(|| format!("{RUNNER_IMAGE}:{}", options.runner_version));
    let has_image = |image: String| async move {
        call(&["image", "inspect", &image], debug, true).await.0 == Some(0)
    };
    let mut mine = Vec::new();
    if !has_image(base.clone()).await {
        (options.log)(&format!(
            "Downloading {base}. This happens once per runner version…"
        ));
        if call(&["image", "pull", &base], debug, false).await.0 != Some(0) {
            return Err(fail(
                "ISOLATED_IMAGE",
                format!("Could not download {base}."),
            ));
        }
        if options.image.is_none() {
            mine.push(base.clone());
        }
    }
    let dns_check = format!(
        "for try in 1 2 3 4 5; do\n  RES_OPTIONS=\"timeout:1 attempts:1\" getent ahostsv4 github.com >/dev/null && exit 0\ndone\nexit {NO_DNS}"
    );
    if call(
        &["run", "--rm", &base, "sh", "-c", &dns_check],
        debug,
        false,
    )
    .await
    .0 == Some(NO_DNS)
    {
        return Err(fail("ISOLATED_DNS", dns_message(&base)));
    }
    let tools = options.image.is_none();
    let image = job_image(&base, tools);
    mine.push(image.clone());
    if !has_image(image.clone()).await {
        (options.log)(&format!(
            "Building the job image from {base}. This happens once per runner version…"
        ));
        let context = std::env::temp_dir().join(format!(
            "relayrunner-image-{}-{}",
            std::process::id(),
            fastrand::u32(..)
        ));
        let written = std::fs::create_dir_all(&context)
            .and_then(|()| std::fs::write(context.join("Dockerfile"), dockerfile(&base, tools)))
            .and_then(|()| std::fs::write(context.join("start.sh"), START_SCRIPT));
        let build = match written {
            Ok(()) => {
                let context = context.to_string_lossy().to_string();
                call(
                    &["build", "--progress", "plain", "--tag", &image, &context],
                    debug,
                    false,
                )
                .await
            }
            Err(e) => (None, e.to_string()),
        };
        let _ = std::fs::remove_dir_all(&context);
        // The build leaves Apple's builder VM behind; it comes back by itself when needed.
        call(&["builder", "stop"], debug, false).await;
        call(&["builder", "delete"], debug, false).await;
        if build.0 != Some(0) {
            let dns = [
                "Temporary failure resolving",
                "Could not resolve host",
                "Name or service not known",
            ];
            if dns.iter().any(|d| build.1.contains(d)) {
                return Err(fail("ISOLATED_DNS", dns_message(&base)));
            }
            return Err(fail(
                "ISOLATED_IMAGE",
                format!("Could not build the job image from {base}."),
            ));
        }
    }
    let mut in_use = vec![base.clone(), image.clone()];
    in_use.extend(options.keep.iter().cloned());
    prune(
        &options.home.join("isolated-images.json"),
        &in_use,
        &mine,
        debug,
        options.log,
    )
    .await;
    let cores = crate::sys::cpu_count();
    let (cpus, memory_gb) = vm_size(
        options.slots,
        options.size,
        cores,
        crate::sys::total_memory().await,
    );
    Ok(Isolation {
        base,
        image,
        local_network: options.local_network,
        debug: options.debug.clone(),
        runner_version: options.runner_version.clone(),
        cpus,
        memory_gb,
    })
}

/// Deletes images earlier runs downloaded or built that this one doesn't use. Images the user got
/// themselves are never in the record.
async fn prune(
    file: &Path,
    in_use: &[String],
    mine: &[String],
    debug: Option<&DebugLog>,
    log: &(dyn Fn(&str) + Sync),
) {
    let recorded: Vec<String> = std::fs::read_to_string(file)
        .ok()
        .and_then(|t| serde_json::from_str::<Vec<serde_json::Value>>(&t).ok())
        .map(|list| {
            list.into_iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    for image in &recorded {
        if !in_use.contains(image)
            && call(&["image", "delete", image], debug, false).await.0 == Some(0)
        {
            log(&format!("Removed the old image {image}."));
        }
    }
    let keep: Vec<&String> = in_use
        .iter()
        .filter(|i| recorded.contains(i) || mine.contains(i))
        .collect();
    if let Ok(text) = serde_json::to_string_pretty(&keep) {
        let _ = std::fs::write(file, format!("{text}\n"));
    }
}

/// The VM's name, which is also how a running job is found and deleted.
pub fn container_name(route_id: &str) -> String {
    let mut name = String::from("relayrunner-");
    let mut dash = false;
    for c in route_id.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            name.push(c);
            dash = false;
        } else if !dash {
            name.push('-');
            dash = true;
        }
    }
    name
}

/// `container run` arguments for one job. The JIT config travels in the environment, so it never
/// shows in the process list.
pub fn run_args(route_id: &str, isolation: &Isolation) -> Vec<String> {
    let mut args: Vec<String> = [
        "run",
        "--rm",
        "--name",
        &container_name(route_id),
        "--cpus",
        &isolation.cpus.to_string(),
        "--memory",
        &format!("{}g", isolation.memory_gb),
        "--progress",
        "none",
        "-e",
        "RUNNER_JIT_CONFIG",
        "-e",
        "ACTIONS_RUNNER_PRINT_LOG_TO_STDOUT=false",
    ]
    .map(String::from)
    .into();
    if isolation.local_network {
        args.extend(["-e".into(), "RELAYRUNNER_LOCAL_NETWORK=1".into()]);
    }
    args.extend(
        [
            "--user",
            "0",
            "--cap-add",
            "ALL",
            &isolation.image,
            START_PATH,
        ]
        .map(String::from),
    );
    args
}

/// Deletes a job's VM after a run that didn't end cleanly. The first delete can fail while the
/// VM's processes are still being killed, so it gets a second try.
pub async fn cleanup(route_id: &str, isolation: &Arc<Isolation>) {
    let name = container_name(route_id);
    let args = ["delete", "--force", name.as_str()];
    if call(&args, Some(&isolation.debug), false).await.0 != Some(0) {
        call(&args, Some(&isolation.debug), false).await;
    }
}

/// Apple's `container` CLI. Tests point RELAYRUNNER_CONTAINER at a stand-in.
pub fn container_command() -> String {
    std::env::var("RELAYRUNNER_CONTAINER").unwrap_or_else(|_| "container".into())
}

/// Runs a `container` command to the end and logs it. (exit code or None when it couldn't start,
/// what it printed unless `quiet`).
async fn call(args: &[&str], debug: Option<&DebugLog>, quiet: bool) -> (Option<i32>, String) {
    let command = container_command();
    let result = tokio::process::Command::new(&command)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .await;
    let (code, output) = match result {
        Ok(out) => {
            let text = if quiet {
                String::new()
            } else {
                format!(
                    "{}{}",
                    String::from_utf8_lossy(&out.stdout),
                    String::from_utf8_lossy(&out.stderr)
                )
            };
            (out.status.code().or(Some(-1)), text)
        }
        Err(e) => (None, format!("{e}\n")),
    };
    if let Some(debug) = debug {
        debug.write(&format!(
            "$ {command} {}\n{output}exit {code:?}",
            args.join(" ")
        ));
    }
    (code, output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_images_match_older_versions() {
        // The tags older (TypeScript) versions gave the same base, so their images are reused.
        let base = "ghcr.io/actions/actions-runner:2.330.0";
        assert_eq!(job_image(base, true), "relayrunner-runner:3d4e65219708");
        assert_eq!(job_image(base, false), "relayrunner-runner:2bc0e1cc2f65");
    }

    #[test]
    fn sizes_vms() {
        let gb = 1u64 << 30;
        assert_eq!(vm_size(2, Wanted::default(), 12, 36 * gb), (6, 9));
        assert_eq!(vm_size(8, Wanted::default(), 8, 16 * gb), (2, 2));
        assert_eq!(
            vm_size(
                1,
                Wanted {
                    cpus: Some(3),
                    memory_gb: Some(5)
                },
                8,
                16 * gb
            ),
            (3, 5)
        );
        assert_eq!(
            slots_for(
                Wanted {
                    cpus: Some(4),
                    memory_gb: None
                },
                12,
                36 * gb
            ),
            Some(3)
        );
        assert_eq!(slots_for(Wanted::default(), 12, 36 * gb), None);
        assert!(
            check_fits(
                Wanted {
                    cpus: None,
                    memory_gb: Some(20)
                },
                2,
                36 * gb
            )
            .is_err()
        );
        assert!(parse_size(Some("x"), None, 8, 16 * gb).is_err());
        assert!(parse_size(Some("9"), None, 8, 16 * gb).is_err());
        assert_eq!(
            parse_size(Some("2"), Some("4"), 8, 16 * gb).unwrap(),
            Wanted {
                cpus: Some(2),
                memory_gb: Some(4)
            }
        );
    }

    #[test]
    fn names_containers_and_builds_run_args() {
        assert_eq!(container_name("RT_1.ab"), "relayrunner-rt-1-ab");
        let isolation = Isolation {
            base: "b".into(),
            image: "relayrunner-runner:x".into(),
            local_network: true,
            debug: DebugLog {
                path: "/dev/null".into(),
            },
            runner_version: "2.330.0".into(),
            cpus: 4,
            memory_gb: 8,
        };
        let args = run_args("rt_1", &isolation).join(" ");
        assert_eq!(
            args,
            "run --rm --name relayrunner-rt-1 --cpus 4 --memory 8g --progress none -e RUNNER_JIT_CONFIG -e ACTIONS_RUNNER_PRINT_LOG_TO_STDOUT=false -e RELAYRUNNER_LOCAL_NETWORK=1 --user 0 --cap-add ALL relayrunner-runner:x /usr/local/bin/relayrunner-start"
        );
    }
}
