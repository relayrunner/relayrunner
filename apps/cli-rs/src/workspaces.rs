//! `relayrunner workspaces [list|add|remove]`: which of its owner's workspaces this machine runs
//! jobs in. A port of apps/cli/machine-workspaces.ts and workspaces-command.ts, without the
//! interactive picker.

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

pub fn command(credentials: &Credentials, args: &[String]) -> Result<(), Error> {
    let name = &credentials.machine.name;
    let action = args.first().map(String::as_str).unwrap_or("list");
    let current = match fetch(credentials, None) {
        Outcome::Ok(choice) => choice,
        Outcome::NotFound => unreachable!("only changes answer not found"),
        Outcome::Failed(e) => return Err(e),
    };
    match action {
        "list" => {
            if args.iter().any(|a| a == "--json") {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&current).expect("serializes")
                );
            } else {
                println!("{name} runs jobs in:");
                for w in &current.workspaces {
                    println!("  ✓ {}", label(w));
                }
                if current.workspaces.is_empty() {
                    println!("  (none: it takes no jobs)");
                }
                if !current.others.is_empty() {
                    println!("\nNot in:");
                    for w in &current.others {
                        println!("  · {}", label(w));
                    }
                }
            }
            Ok(())
        }
        "add" | "remove" => {
            let adding = action == "add";
            let query = args.get(1).ok_or_else(|| {
                Error::new(
                    "USAGE",
                    format!("Name the workspace: `relayrunner workspaces {action} <name>`."),
                )
            })?;
            let (candidates, elsewhere) = if adding {
                (&current.others, &current.workspaces)
            } else {
                (&current.workspaces, &current.others)
            };
            let picked = match find(candidates, query) {
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
                    if let Ok(Some(w)) = find(elsewhere, query) {
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
                    return Err(Error::new(
                        "USAGE",
                        format!("None of your workspaces is called {query:?}."),
                    ));
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
                Outcome::Failed(e) => Err(e),
            }
        }
        other => Err(Error::new(
            "USAGE",
            format!("Unknown workspaces command {other:?}. Use list, add or remove."),
        )),
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
