//! `relayrunner` in Rust: `connect` (with sign-in, runner install and updates, and VMs), `init`,
//! `login`, `whoami`, `pause`, `resume`, `share`, `workspaces`, `firewall` and `history`. It shares
//! ~/.relayrunner with older (TypeScript) versions.

mod api;
mod connect;
mod connection;
mod credentials;
mod device;
mod error;
mod events;
mod firewall;
mod history;
mod init;
mod install;
mod isolated;
mod jit_config;
mod job;
mod live;
mod login;
mod pause;
mod protocol;
mod share;
mod sys;
mod ui;
mod update_check;
mod usage;
mod whoami;
mod workspaces;

use std::sync::LazyLock;

pub const VERSION: &str = env!("RELAYRUNNER_VERSION");
pub static USER_AGENT: LazyLock<String> = LazyLock::new(|| format!("relayrunner-cli/{VERSION}"));

const SERVER_HELP: &str =
    "RelayRunner URL (default: $RELAYRUNNER_URL or https://app.relayrunner.dev)";
const SHARE_HELP: &str = "Who can run jobs on this machine: only-me (jobs you started) or anyone in your workspaces. Skips the question.";

/// A command's name, what it does, its usage line, and its options with what each does.
type Command = (
    &'static str,
    &'static str,
    &'static str,
    &'static [(&'static str, &'static str)],
);

const COMMANDS: &[Command] = &[
    (
        "connect",
        "Put this machine online for your workspaces and run the jobs the gateway sends it. Signs in on first run; Ctrl-C takes the machine offline.",
        "relayrunner connect [options]",
        &[
            ("--server URL", SERVER_HELP),
            (
                "--name NAME",
                "Suggested machine name when signing in (default: this computer's name)",
            ),
            ("--share only-me|anyone", SHARE_HELP),
            (
                "--concurrency N",
                "How many jobs to run at once (default: 2 with 8 or more CPU cores, otherwise 1; with --cpus or --memory, as many as fit)",
            ),
            (
                "--isolated",
                "Run each job in its own Linux VM, away from your files. The default on a Mac with Apple silicon and Apple's container tool.",
            ),
            (
                "--no-isolated",
                "Run jobs on this machine itself, where they can read your files.",
            ),
            (
                "--macos",
                "Also take macOS jobs, which run on this Mac itself. Linux jobs still run in a VM.",
            ),
            (
                "--cpus N",
                "CPUs for each job's VM (default: an even share of this Mac's cores)",
            ),
            (
                "--memory GB",
                "Memory for each job's VM, in GB (default: an even share of half this Mac's)",
            ),
            (
                "--image IMAGE",
                "Your own runner image for the VMs (default: GitHub's, with everyday tools)",
            ),
            (
                "--local-network",
                "Let jobs in VMs reach this Mac and your local network. They can't by default.",
            ),
            (
                "--events",
                "For apps that run connect: JSON events on stdout, one per line, and `pause` or `resume` on stdin",
            ),
        ],
    ),
    (
        "init",
        "Route this repo's GitHub Actions jobs through RelayRunner, so they run on your machine when it's online. Edits workflow files; never commits.",
        "relayrunner init [--plan] [--apply <jobs>] [--json]",
        &[
            (
                "--plan",
                "List every job and whether it can be routed. Changes nothing.",
            ),
            (
                "--apply JOBS",
                "Route these jobs without prompting: comma-separated ids or file:job, or `all` for every ready job",
            ),
            (
                "--json",
                "Print the result as JSON (with --plan or --apply)",
            ),
        ],
    ),
    (
        "login",
        "Sign this machine in without putting it online. You pick its workspaces when you approve it. Run `relayrunner connect` afterwards to take jobs.",
        "relayrunner login [--server URL] [--name NAME] [--share only-me|anyone]",
        &[
            ("--server URL", SERVER_HELP),
            (
                "--name NAME",
                "Suggested machine name (default: this computer's name)",
            ),
            ("--share only-me|anyone", SHARE_HELP),
        ],
    ),
    (
        "whoami",
        "Show which machine this computer is signed in as and the workspaces it's in, checked with the gateway.",
        "relayrunner whoami [--server URL] [--json]",
        &[
            (
                "--server URL",
                "Only report a sign-in for this RelayRunner URL (default: the saved one)",
            ),
            ("--json", "Print the result as JSON"),
        ],
    ),
    (
        "pause",
        "Stop new jobs routing to this machine. It stays connected and finishes a job it's running.",
        "relayrunner pause",
        &[],
    ),
    (
        "resume",
        "Let jobs route to this machine again after `relayrunner pause`.",
        "relayrunner resume",
        &[],
    ),
    (
        "share",
        "Show or change who can run jobs on this machine: only-me (jobs you started) or anyone in your workspaces.",
        "relayrunner share [only-me|anyone]",
        &[],
    ),
    (
        "workspaces",
        "Show or change which of your workspaces this machine runs jobs in: `list` (the default), `add <name>`, `remove <name>`.",
        "relayrunner workspaces [list [--json] | add [name] | remove [name]]",
        &[("--json", "With list: print the result as JSON")],
    ),
    (
        "firewall",
        "Show or change the firewall on this Mac that keeps isolated jobs off the Mac and your local network.",
        "relayrunner firewall [on|off]",
        &[],
    ),
    (
        "history",
        "Show the jobs this machine ran most recently, newest first.",
        "relayrunner history [--json] [--limit N]",
        &[
            ("--json", "Print the jobs as JSON"),
            ("--limit", "How many jobs to show (default 20)"),
        ],
    ),
];

fn usage() -> String {
    let width = COMMANDS.iter().map(|c| c.0.len()).max().unwrap_or(0);
    let mut out = format!(
        "Run GitHub Actions jobs on your machine through the RelayRunner gateway. (relayrunner {VERSION})\n\nUsage: relayrunner <command> [options]\n\nCommands:\n"
    );
    for (name, about, _, _) in COMMANDS {
        out.push_str(&format!("  {name:<width$}  {about}\n"));
    }
    out.push_str("\nRun `relayrunner <command> --help` for a command's options.");
    out
}

fn command_help(name: &str) -> Option<String> {
    let (_, about, usage, options) = COMMANDS.iter().find(|c| c.0 == name)?;
    let mut out = format!("{about}\n\nUsage: {usage}\n");
    if !options.is_empty() {
        let width = options.iter().map(|o| o.0.len()).max().unwrap_or(0);
        out.push_str("\nOptions:\n");
        for (flag, help) in *options {
            out.push_str(&format!("  {flag:<width$}  {help}\n"));
        }
    }
    Some(out.trim_end().to_string())
}

fn signed_in() -> Result<credentials::Credentials, error::Error> {
    credentials::read()
        .map_err(|e| error::Error::new("CREDENTIALS_UNREADABLE", e.to_string()))?
        .ok_or_else(|| {
            error::Error::new(
                "NOT_SIGNED_IN",
                "Not signed in. Run `relayrunner login` or `relayrunner connect` to sign in.",
            )
        })
}

/// Runs a command that only talks to the gateway, off the async runtime.
async fn plain(f: impl FnOnce() -> Result<(), error::Error> + Send + 'static) -> i32 {
    match sys::blocking(f).await {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (command, rest) = args
        .split_first()
        .map_or(("", &[][..]), |(c, r)| (c.as_str(), r));
    let rest = rest.to_vec();
    let wants_help = rest.iter().any(|a| a == "--help" || a == "-h");
    let code = match command {
        "--version" | "-v" => {
            println!("{VERSION}");
            0
        }
        "" | "--help" | "-h" | "help" => {
            match rest.first().and_then(|c| command_help(c)) {
                Some(help) => println!("{help}"),
                None => println!("{}", usage()),
            }
            0
        }
        name if wants_help && command_help(name).is_some() => {
            println!("{}", command_help(name).unwrap_or_default());
            0
        }
        "connect" => match connect::Args::parse(&rest) {
            Ok(args) => connect::command(args).await,
            Err(e) => {
                if rest.iter().any(|a| a == "--events") {
                    events::start();
                    events::emit(
                        "error",
                        serde_json::json!({ "code": e.code, "message": e.message }),
                    );
                }
                eprintln!("{e}");
                1
            }
        },
        "login" => connect::login_command(&rest).await,
        "whoami" => match sys::blocking(move || whoami::command(&rest)).await {
            Ok(code) => code,
            Err(e) => {
                eprintln!("{e}");
                1
            }
        },
        "pause" | "resume" => {
            let paused = command == "pause";
            plain(move || pause::command(&signed_in()?, paused)).await
        }
        "share" => {
            plain(move || share::command(&signed_in()?, rest.first().map(String::as_str))).await
        }
        "workspaces" => plain(move || workspaces::command(&signed_in()?, &rest)).await,
        "firewall" => match firewall::command(rest.first().map(String::as_str)).await {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("{e}");
                1
            }
        },
        "init" => init::command(&rest).await,
        "history" => match history::command(&rest) {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("{e}");
                1
            }
        },
        other => {
            eprintln!("Unknown command {other:?}.\n\n{}", usage());
            2
        }
    };
    live::end();
    // Exit here rather than return: the runtime would otherwise wait on a blocking read of stdin.
    std::process::exit(code)
}
