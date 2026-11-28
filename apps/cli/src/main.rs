//! `relayrunner` in Rust: `connect` (with sign-in, runner install and updates, and VMs), `init`,
//! `login`, `whoami`, `pause`, `resume`, `share`, `workspaces`, `firewall`, `history`, `jobs`,
//! `benchmark` (once `eval`), `blacksmith` and `feedback`. It shares ~/.relayrunner with older (TypeScript) versions.

mod api;
mod blacksmith;
mod connect;
mod connection;
mod credentials;
mod device;
mod error;
mod eval;
mod events;
mod feedback;
mod firewall;
mod history;
mod init;
mod install;
mod isolated;
mod jit_config;
mod job;
mod jobs;
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
        "Put this machine online for your workspaces, as a personal runner unless you share it, and run the jobs the gateway sends it. Signs in on first run; Ctrl-C takes the machine offline.",
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
        "relayrunner init [--plan] [--apply <jobs>] [--exact] [--allow-deploy <jobs>] [--json]",
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
                "--exact",
                "Keep each job's runs-on label under its provider instead of writing its shape (os, arch, cpus), so only that provider and your machines take it",
            ),
            (
                "--allow-deploy JOBS",
                "Let these jobs be routed even though they look like deploy jobs. The machine gets their secrets and cloud access",
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
        "Show or change who can run jobs on this machine: only-me (a personal runner: jobs you started) or anyone in your workspaces (a shared runner).",
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
    (
        "jobs",
        "Show the jobs this machine ran in the last week as the gateway has them, or one job's steps and why it failed.",
        "relayrunner jobs [--json] [--limit N] [--before MS] [--since MS] [--repo OWNER/NAME] [--workflow NAME] [--result succeeded|failed|canceled] | relayrunner jobs <id> [--json]",
        &[
            ("--json", "Print the result as JSON"),
            ("--limit", "How many jobs to show (default 50, at most 100)"),
            (
                "--before",
                "Show jobs that finished before this time, in ms (the `next` of a page)",
            ),
            ("--since", "Show jobs that finished after this time, in ms"),
            ("--repo", "Show only this repo's jobs"),
            ("--workflow", "Show only this workflow's jobs"),
            (
                "--result",
                "Show only jobs that succeeded, failed or were canceled",
            ),
        ],
    ),
    (
        "benchmark",
        "Benchmark a hosted provider on one of your workflows: 5 runs from the default branch, compared with its recent runs. It's the dashboard's Evaluate, so the dashboard shows it live.",
        "relayrunner benchmark [provider] [options] | benchmark watch [id] | benchmark list [--provider P] | benchmark stop <id>",
        &[
            (
                "--repo OWNER/NAME",
                "The repository (default: this clone's origin)",
            ),
            (
                "--workflow FILE|NAME",
                "The workflow: its path, file name or name",
            ),
            (
                "--vcpus N",
                "Machine size, from the sizes the provider offers (default: 4)",
            ),
            (
                "--workspace NAME",
                "A name, slug or id (default: the one on the repo's GitHub account, or your only one)",
            ),
            (
                "--yes",
                "Don't ask. Exits with code 3 instead of waiting on a step you need to do",
            ),
            (
                "--detach",
                "Start it and exit with its id and dashboard link",
            ),
            (
                "--json",
                "Print the result as JSON on stdout, progress on stderr",
            ),
            ("--verbose", "With a failed run, show the whole log excerpt"),
        ],
    ),
    (
        "blacksmith",
        "Connect your Blacksmith organization so the dashboard shows its real usage. You approve an org token in your browser as a Blacksmith org admin; only that token is sent.",
        "relayrunner blacksmith connect [--workspace NAME] [--yes]",
        &[
            (
                "--workspace NAME",
                "The workspace to connect it to: a name, slug or id (default: the one on the same GitHub organization)",
            ),
            (
                "--yes",
                "Download Blacksmith's CLI into ~/.relayrunner/bin without asking, if it isn't installed",
            ),
        ],
    ),
    (
        "feedback",
        "Send a message to the RelayRunner team. It goes with your name and email, so we can reply, unless you pass --anonymous.",
        "relayrunner feedback \"MESSAGE\" [--category bug|confusing|feature_request|other] [--anonymous] | relayrunner feedback --file PATH",
        &[
            ("--file PATH", "Send what's in this file instead"),
            ("--anonymous", "Send it without your name or email"),
            (
                "--category NAME",
                "bug, confusing, feature_request or other (default: other)",
            ),
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
    // `eval` is benchmark's old name, kept so scripts that use it still work.
    let name = if name == "eval" { "benchmark" } else { name };
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

/// `relayrunner benchmark` (or its old name `eval`), signing in first when this computer isn't yet and someone can approve it.
async fn benchmark_command(rest: Vec<String>) -> i32 {
    if matches!(credentials::read(), Ok(None)) && ui::can_ask() {
        ui::info("Sign in first. Evaluations run as you, in your workspaces.");
        let code = connect::login_command(&[]).await;
        if code != 0 {
            return code;
        }
    }
    match sys::blocking(move || eval::command(&signed_in()?, &rest)).await {
        Ok(code) => code,
        Err(e) => {
            eprintln!("{e}");
            if e.code == "USAGE" { 2 } else { 1 }
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
                    events::emit(&events::Event::error(e.code, e.message.clone()));
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
        "jobs" => plain(move || jobs::command(&signed_in()?, &rest)).await,
        "benchmark" | "eval" => benchmark_command(rest).await,
        "blacksmith" => plain(move || blacksmith::command(&signed_in()?, &rest)).await,
        "feedback" => plain(move || feedback::command(&signed_in()?, &rest)).await,
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
