//! `relayrunner` in Rust: `connect` (with sign-in, runner install and updates, and VMs),
//! `workspaces [list|add|remove]` and `share only-me|anyone`, the commands the Mac app runs. It
//! shares ~/.relayrunner with the TypeScript CLI. The other commands are still TypeScript only.

mod api;
mod connect;
mod connection;
mod credentials;
mod device;
mod error;
mod events;
mod install;
mod isolated;
mod jit_config;
mod job;
mod login;
mod protocol;
mod share;
mod sys;
mod usage;
mod workspaces;

use std::sync::LazyLock;

pub const VERSION: &str = env!("RELAYRUNNER_VERSION");
pub static USER_AGENT: LazyLock<String> = LazyLock::new(|| format!("relayrunner-cli/{VERSION}"));

const USAGE: &str = "Run GitHub Actions jobs on your machine through the RelayRunner gateway.

Usage:
  relayrunner connect [--events] [--concurrency N] [--share only-me|anyone]
                      [--isolated | --no-isolated] [--macos] [--cpus N] [--memory GB]
                      [--image IMAGE] [--local-network] [--server URL] [--name NAME]
  relayrunner workspaces [list [--json] | add <name> | remove <name>]
  relayrunner share only-me|anyone
  relayrunner --version";

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (command, rest) = args
        .split_first()
        .map_or(("", &[][..]), |(c, r)| (c.as_str(), r));
    let code = match command {
        "--version" | "-v" => {
            println!("{VERSION}");
            0
        }
        "" | "--help" | "-h" | "help" => {
            println!("{USAGE}");
            0
        }
        "connect" if rest.iter().any(|a| a == "--help" || a == "-h") => {
            println!("{USAGE}");
            0
        }
        "connect" => match connect::Args::parse(rest) {
            Ok(args) => connect::command(args).await,
            Err(e) => {
                eprintln!("{e}");
                if rest.iter().any(|a| a == "--events") {
                    events::start();
                    events::emit(
                        "error",
                        serde_json::json!({ "code": e.code, "message": e.message }),
                    );
                }
                1
            }
        },
        "workspaces" | "share" => {
            let rest = rest.to_vec();
            let command = command.to_string();
            let result = sys::blocking(move || {
                let credentials = credentials::read()
                    .map_err(|e| error::Error::new("CREDENTIALS_UNREADABLE", e.to_string()))?
                    .ok_or_else(|| {
                        error::Error::new("NOT_SIGNED_IN", "Not signed in. Run `relayrunner login` or `relayrunner connect` to sign in.")
                    })?;
                if command == "workspaces" {
                    workspaces::command(&credentials, &rest)
                } else {
                    share::command(&credentials, rest.first().map_or("", String::as_str))
                }
            })
            .await;
            match result {
                Ok(()) => 0,
                Err(e) => {
                    eprintln!("{e}");
                    1
                }
            }
        }
        other => {
            eprintln!(
                "Unknown command {other:?}. This build has connect, workspaces and share.\n\n{USAGE}"
            );
            2
        }
    };
    // Exit here rather than return: the runtime would otherwise wait on a blocking read of stdin.
    std::process::exit(code)
}
