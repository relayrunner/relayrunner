//! `relayrunner workspaces [list|add|remove]`: which of its owner's workspaces this machine runs
//! jobs in. A port of apps/cli/machine-workspaces.ts and workspaces-command.ts.

use crate::api::{self, Reply};
use crate::credentials::Credentials;
use crate::error::Error;
use crate::share::{self, Share};
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Choice {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slug: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logo: Option<String>,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct MachineInfo {
    pub id: String,
    pub name: String,
    pub sharing: String,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct MachineWorkspaces {
    pub machine: MachineInfo,
    pub workspaces: Vec<Choice>,
    pub others: Vec<Choice>,
}

enum Outcome {
    Ok(MachineWorkspaces),
    NotFound,
    Failed(Error),
}

fn fetch(credentials: &Credentials, change: Option<(&str, &str)>) -> Outcome {
    let server = &credentials.server;
    let (method, path) = match change {
        None => ("GET", "/api/machines/me/workspaces".to_string()),
        Some((action, id)) => (
            if action == "add" { "PUT" } else { "DELETE" },
            format!(
                "/api/machines/me/workspaces/{}",
                url::form_urlencoded::byte_serialize(id.as_bytes()).collect::<String>()
            ),
        ),
    };
    let failed = |reason: String| Outcome::Failed(Error::new("WORKSPACES_FAILED", reason));
    match api::call_as_machine(credentials, method, &path, None) {
        Reply::Ok(body) => match serde_json::from_value(body) {
            Ok(choice) => Outcome::Ok(choice),
            Err(_) => failed(format!("{server} sent an unexpected response")),
        },
        Reply::Revoked => Outcome::Failed(share::revoked(&credentials.machine.name)),
        Reply::Status(404, body) if change.is_some() && body["error"]["code"] == "NOT_FOUND" => {
            Outcome::NotFound
        }
        Reply::Status(404 | 405, _) => {
            failed(format!("{server} doesn't support choosing workspaces yet"))
        }
        Reply::Status(403, _) => {
            failed("only the machine's owner can change its workspaces".into())
        }
        Reply::Status(status, body) => failed(api::failure_reason(server, status, &body)),
        Reply::Unreachable(reason) => failed(reason),
    }
}

fn names(list: &[Choice]) -> String {
    let names: Vec<&str> = list.iter().map(|w| w.name.as_str()).collect();
    match names.split_last() {
        None => String::new(),
        Some((last, [])) => (*last).to_string(),
        Some((last, rest)) => format!("{} and {last}", rest.join(", ")),
    }
}

fn label(w: &Choice) -> String {
    match &w.slug {
        Some(slug) if *slug != w.name => format!("{} ({slug})", w.name),
        _ => w.name.clone(),
    }
}

/// The workspace `query` names: its id, or its name or slug in any case.
fn find<'a>(list: &'a [Choice], query: &str) -> Result<Option<&'a Choice>, Vec<&'a Choice>> {
    if let Some(w) = list.iter().find(|w| w.id == query) {
        return Ok(Some(w));
    }
    let wanted = query.trim().to_lowercase();
    let found: Vec<&Choice> = list
        .iter()
        .filter(|w| {
            w.name.to_lowercase() == wanted
                || w.slug.as_ref().is_some_and(|s| s.to_lowercase() == wanted)
        })
        .collect();
    match found.len() {
        0 => Ok(None),
        1 => Ok(Some(found[0])),
        _ => Err(found),
    }
}

/// Why a machine has no workspaces, for `connect` and `whoami`: its owner has none yet (install
/// RelayRunner), or the machine just isn't in any of theirs (`relayrunner workspaces add`).
pub fn empty_notice(credentials: &Credentials) -> String {
    let name = &credentials.machine.name;
    if let Outcome::Ok(choice) = fetch(credentials, None)
        && !choice.others.is_empty()
    {
        return format!(
            "{name} isn't in any of your workspaces, so it takes no jobs. Add one with `relayrunner workspaces add <name>` ({}).",
            names(&choice.others)
        );
    }
    no_workspace_yet(name, &credentials.server)
}

/// Said after signing in when the machine isn't in any workspace yet.
pub fn no_workspace_yet(machine: &str, server: &str) -> String {
    format!(
        "{machine} isn't in a workspace yet. It takes jobs once RelayRunner is installed on a GitHub account or org you belong to, or once an org owner accepts your install request.\nInstall: {}/api/github/install",
        server.trim_end_matches('/')
    )
}

/// What `relayrunner workspaces` prints.
fn describe(current: &MachineWorkspaces) -> String {
    let MachineWorkspaces {
        machine,
        workspaces,
        others,
    } = current;
    let name = &machine.name;
    if workspaces.is_empty() && others.is_empty() {
        return format!(
            "{name} isn't in a workspace yet. It takes jobs once RelayRunner is installed on a GitHub account or org you belong to."
        );
    }
    let mut lines = vec![format!("{name} runs jobs in:")];
    lines.extend(workspaces.iter().map(|w| format!("  ✓ {}", label(w))));
    if workspaces.is_empty() {
        lines.push("  (none: it takes no jobs)".into());
    }
    if !others.is_empty() {
        lines.push(String::new());
        lines.push("Not in:".into());
        lines.extend(others.iter().map(|w| format!("  · {}", label(w))));
    }
    if let Some(share) = Share::from_sharing(&machine.sharing) {
        lines.push(String::new());
        lines.push(format!(
            "Sharing: {}: {}",
            share.choice(),
            share.meaning("these workspaces")
        ));
    }
    if !others.is_empty() {
        lines.push("Add one with `relayrunner workspaces add <name>`.".into());
    } else if !workspaces.is_empty() {
        lines.push("Remove one with `relayrunner workspaces remove <name>`.".into());
    }
    lines.join("\n")
}

pub fn command(credentials: &Credentials, args: &[String]) -> Result<(), Error> {
    let name = &credentials.machine.name;
    let action = args.first().map(String::as_str).unwrap_or("list");
    if !matches!(action, "list" | "add" | "remove") {
        return Err(Error::new(
            "USAGE",
            format!("Unknown workspaces command {action:?}. Use list, add or remove."),
        ));
    }
    let current = match fetch(credentials, None) {
        Outcome::Ok(choice) => choice,
        Outcome::NotFound => unreachable!("only changes answer not found"),
        Outcome::Failed(e) if e.code == "WORKSPACES_FAILED" => {
            let verb = if action == "list" { "list" } else { action };
            let what = if action == "list" {
                "workspaces"
            } else {
                "a workspace"
            };
            return Err(Error::new(
                e.code,
                format!("Couldn't {verb} {what} for {name}: {}.", e.message),
            ));
        }
        Outcome::Failed(e) => return Err(e),
    };
    if action == "list" {
        if args.iter().any(|a| a == "--json") {
            println!(
                "{}",
                serde_json::to_string_pretty(&current).expect("serializes")
            );
        } else {
            println!("{}", describe(&current));
        }
        return Ok(());
    }

    let adding = action == "add";
    let (candidates, elsewhere) = if adding {
        (&current.others, &current.workspaces)
    } else {
        (&current.workspaces, &current.others)
    };
    if current.workspaces.is_empty() && current.others.is_empty() {
        return Err(Error::new(
            "NO_WORKSPACES",
            no_workspace_yet(name, &credentials.server),
        ));
    }
    let picked = match args.get(1) {
        Some(query) => match find(candidates, query) {
            Ok(Some(w)) => w,
            Err(several) => {
                let ids: Vec<String> = several
                    .iter()
                    .map(|w| format!("  {}  {}", label(w), w.id))
                    .collect();
                return Err(Error::new(
                    "USAGE",
                    format!(
                        "More than one workspace is called {query:?}. Name it by id:\n{}",
                        ids.join("\n")
                    ),
                ));
            }
            Ok(None) => {
                if let Ok(found) = find(elsewhere, query)
                    && let Some(w) = found
                {
                    println!(
                        "{name} {} {}.",
                        if adding {
                            "already runs jobs in"
                        } else {
                            "doesn't run jobs in"
                        },
                        w.name
                    );
                    return Ok(());
                }
                let mut message = format!("None of your workspaces is called {query:?}.");
                if !candidates.is_empty() {
                    message.push_str(if adding {
                        "\nWorkspaces you can add:"
                    } else {
                        "\nWorkspaces you can remove:"
                    });
                    for w in candidates {
                        message.push_str(&format!("\n  {}", label(w)));
                    }
                }
                return Err(Error::new("USAGE", message));
            }
        },
        None if candidates.is_empty() => {
            println!(
                "{name} {}",
                if adding {
                    "already runs jobs in all your workspaces."
                } else {
                    "isn't in any workspace."
                }
            );
            return Ok(());
        }
        None if !crate::ui::can_ask() => {
            return Err(Error::new(
                "USAGE",
                format!("Name the workspace: `relayrunner workspaces {action} <name>`."),
            ));
        }
        None => {
            let question = if adding {
                format!("Which workspace should {name} run jobs in too?")
            } else {
                format!("Which workspace should {name} stop running jobs in?")
            };
            let choices: Vec<crate::ui::Choice> = candidates
                .iter()
                .map(|w| crate::ui::Choice {
                    label: w.name.clone(),
                    hint: w.slug.clone().filter(|s| *s != w.name),
                })
                .collect();
            match crate::ui::select(&question, &choices, 0) {
                Some(i) => &candidates[i],
                None => return Ok(()),
            }
        }
    };
    match fetch(credentials, Some((action, &picked.id))) {
        Outcome::Ok(now) => {
            if adding {
                println!("{name} now runs jobs in {}.", names(&now.workspaces));
                if Share::from_sharing(&now.machine.sharing) == Some(Share::Anyone) {
                    eprintln!(
                        "Warning: {name} is set to run anyone's jobs, so anyone who can push to {}'s private repos can run jobs on it. Use `relayrunner share only-me` to limit it to jobs you started.",
                        picked.name
                    );
                }
            } else if now.workspaces.is_empty() {
                println!("{name} no longer runs jobs in {}.", picked.name);
                eprintln!(
                    "{name} isn't in any workspace now, so it takes no jobs. Add one with `relayrunner workspaces add <name>`."
                );
            } else {
                println!(
                    "{name} no longer runs jobs in {}. It still runs jobs in {}.",
                    picked.name,
                    names(&now.workspaces)
                );
            }
            Ok(())
        }
        Outcome::NotFound => Err(Error::new(
            "NOT_FOUND",
            format!("You're no longer a member of {}.", picked.name),
        )),
        Outcome::Failed(e) if e.code == "WORKSPACES_FAILED" => Err(Error::new(
            e.code,
            format!("Couldn't {action} {}: {}.", picked.name, e.message),
        )),
        Outcome::Failed(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(id: &str, name: &str, slug: Option<&str>) -> Choice {
        Choice {
            id: id.into(),
            name: name.into(),
            slug: slug.map(Into::into),
            logo: None,
        }
    }

    #[test]
    fn finds_by_id_name_or_slug() {
        let list = vec![
            w("ws_1", "Acme", Some("acme")),
            w("ws_2", "Beta", None),
            w("ws_3", "beta", Some("b2")),
        ];
        assert_eq!(find(&list, "ws_2").unwrap().unwrap().id, "ws_2");
        assert_eq!(find(&list, "ACME").unwrap().unwrap().id, "ws_1");
        assert_eq!(find(&list, "b2").unwrap().unwrap().id, "ws_3");
        assert_eq!(find(&list, "beta").unwrap_err().len(), 2);
        assert!(find(&list, "nope").unwrap().is_none());
    }

    #[test]
    fn joins_names() {
        assert_eq!(
            names(&[w("1", "A", None), w("2", "B", None), w("3", "C", None)]),
            "A, B and C"
        );
    }
}
