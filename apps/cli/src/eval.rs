//! `relayrunner eval`: run a provider evaluation from the terminal. It starts the same evaluation
//! the dashboard's Evaluate page starts (apps/api/src/reports/evaluations.ts), through the same
//! handlers called with the machine's token as its owner (/api/machines/me/evaluations), so the
//! dashboard shows it live, and `eval watch` follows one started in the browser.
//!
//! The steps are the page's: the provider's GitHub App on the workspace's account (confirmed by the
//! person on a personal account, where GitHub can't tell), a workflow whose jobs go through a relay,
//! then five runs compared with the workflow's recent passing runs.

use crate::api::{self, Reply};
use crate::credentials::Credentials;
use crate::error::Error;
use crate::history::duration;
use crate::ui::{self, Style, paint};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::Read;
use std::sync::Mutex;
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

/// How often a running evaluation is read again, and the provider app looked for.
const POLL: Duration = Duration::from_secs(5);
/// How often a waiting evaluation's dispatch is tried again while it's watched, since the push
/// that adds workflow_dispatch may not run the workflow.
const RETRY: Duration = Duration::from_secs(30);
const APP_POLL: Duration = Duration::from_secs(10);
/// How often the live view's clock moves.
const TICK: Duration = Duration::from_secs(1);
/// The size the dashboard starts on.
const DEFAULT_VCPUS: u64 = 4;

/// Exit codes: 0 done, 1 failed, 2 usage, 3 needs the person first, 130 Ctrl-C (still running).
pub const NEEDS_YOU: i32 = 3;
pub const INTERRUPTED: i32 = 130;

const USAGE: &str = "Usage: relayrunner eval [provider] [--repo OWNER/NAME] [--workflow FILE|NAME] [--vcpus N] [--workspace NAME] [--yes] [--detach] [--json]\n       relayrunner eval watch [id] | eval list [--provider P] | eval stop <id>";

#[derive(Debug, Default, PartialEq)]
pub enum Action {
    #[default]
    Start,
    Watch,
    List,
    Stop,
}

#[derive(Debug, Default, PartialEq)]
pub struct Args {
    pub action: Action,
    /// The provider to start one on, or the evaluation's id for watch and stop.
    pub target: Option<String>,
    pub repo: Option<String>,
    pub workflow: Option<String>,
    pub vcpus: Option<u64>,
    pub workspace: Option<String>,
    pub provider: Option<String>,
    pub yes: bool,
    pub detach: bool,
    pub json: bool,
    pub verbose: bool,
}

impl Args {
    pub fn parse(rest: &[String]) -> Result<Args, Error> {
        let usage = || Error::new("USAGE", USAGE);
        let mut args = Args::default();
        let mut rest = rest.iter().peekable();
        match rest.peek().map(|s| s.as_str()) {
            Some("watch") => args.action = Action::Watch,
            Some("list") => args.action = Action::List,
            Some("stop") => args.action = Action::Stop,
            _ => {}
        }
        if args.action != Action::Start {
            rest.next();
        }
        while let Some(arg) = rest.next() {
            let (flag, inline) = match arg.split_once('=') {
                Some((flag, value)) if flag.starts_with("--") => (flag, Some(value.to_string())),
                _ => (arg.as_str(), None),
            };
            let mut value = || {
                inline
                    .clone()
                    .or_else(|| rest.next().cloned())
                    .ok_or_else(usage)
            };
            match flag {
                "--repo" => args.repo = Some(value()?),
                "--workflow" => args.workflow = Some(value()?),
                "--workspace" => args.workspace = Some(value()?),
                "--provider" => args.provider = Some(value()?),
                "--vcpus" => {
                    args.vcpus = Some(value()?.parse().ok().filter(|n| *n > 0).ok_or_else(usage)?)
                }
                "--yes" | "-y" => args.yes = true,
                "--detach" => args.detach = true,
                "--json" => args.json = true,
                "--verbose" => args.verbose = true,
                other if other.starts_with('-') => return Err(usage()),
                other if args.target.is_none() => args.target = Some(other.to_string()),
                _ => return Err(usage()),
            }
        }
        if args.action == Action::Stop && args.target.is_none() {
            return Err(usage());
        }
        if args.repo.as_deref().is_some_and(|repo| !is_repo(repo)) {
            return Err(Error::new(
                "USAGE",
                "--repo takes OWNER/NAME, such as acme/web.",
            ));
        }
        Ok(args)
    }
}

fn is_repo(value: &str) -> bool {
    matches!(value.split_once('/'), Some((owner, name)) if !owner.is_empty() && !name.is_empty() && !name.contains('/'))
}

/// OWNER/NAME from a GitHub remote URL, such as `git@github.com:acme/web.git`.
pub fn repo_from_remote(url: &str) -> Option<String> {
    let url = url.trim();
    let path = url
        .strip_prefix("git@github.com:")
        .or_else(|| url.split_once("github.com/").map(|(_, path)| path))?;
    let path = path.trim_end_matches('/').trim_end_matches(".git");
    is_repo(path).then(|| path.to_string())
}

/// This clone's GitHub repository, from `origin`.
fn current_repo() -> Option<String> {
    let output = std::process::Command::new("git")
        .args(["remote", "get-url", "origin"])
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| repo_from_remote(&String::from_utf8_lossy(&output.stdout)))?
}

// ---- Talking to the gateway ----------------------------------------------------------------------

/// The workspace the calls name: `workspace=` once known, else `owner=` from the repo.
struct Scope {
    workspace: Option<String>,
    owner: Option<String>,
}

impl Scope {
    fn query(&self) -> String {
        match (&self.workspace, &self.owner) {
            (Some(w), _) => format!("workspace={}", encode(w)),
            (None, Some(o)) => format!("owner={}", encode(o)),
            (None, None) => String::new(),
        }
    }
}

fn encode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

enum Got {
    Ok(Value),
    /// The workspace couldn't be told; the owner's workspaces, to pick one.
    Unclear(Vec<Value>),
    /// The API's error code and message, with its status.
    Refused(u16, String, String),
}

fn call(
    credentials: &Credentials,
    method: &str,
    path: &str,
    scope: &Scope,
    body: Option<&Value>,
) -> Result<Got, Error> {
    let sep = if path.contains('?') { '&' } else { '?' };
    let query = scope.query();
    let full = if query.is_empty() {
        format!("/api/machines/me/evaluations{path}")
    } else {
        format!("/api/machines/me/evaluations{path}{sep}{query}")
    };
    let server = &credentials.server;
    match api::call_as_machine(credentials, method, &full, body) {
        Reply::Ok(body) => Ok(Got::Ok(body)),
        Reply::Revoked => Err(crate::share::revoked(&credentials.machine.name)),
        Reply::Status(409, body) if body["error"]["code"] == "EVALUATION_WORKSPACE_UNCLEAR" => {
            Ok(Got::Unclear(
                body["error"]["details"]["workspaces"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default(),
            ))
        }
        Reply::Status(404, body) if body["error"]["code"].is_null() => Err(Error::new(
            "UNSUPPORTED",
            format!("{server} doesn't run evaluations from the CLI yet."),
        )),
        Reply::Status(status, body) => Ok(Got::Refused(
            status,
            body["error"]["code"].as_str().unwrap_or("").to_string(),
            api::failure_reason(server, status, &body),
        )),
        Reply::Unreachable(reason) => Err(Error::new("UNREACHABLE", reason)),
    }
}

fn failed(reason: String) -> Error {
    Error::new("EVALUATION_FAILED", format!("Couldn't evaluate: {reason}."))
}

/// `call` for a body, asking which workspace when the gateway can't tell.
fn get(credentials: &Credentials, path: &str, scope: &mut Scope) -> Result<Value, Error> {
    loop {
        match call(credentials, "GET", path, scope, None)? {
            Got::Ok(body) => return Ok(body),
            Got::Unclear(workspaces) => scope.workspace = Some(pick_workspace(&workspaces)?),
            Got::Refused(404, code, _) if code == "NOT_FOUND" && scope.workspace.is_some() => {
                return Err(Error::new(
                    "NOT_FOUND",
                    format!(
                        "Couldn't find that in {}. Check --workspace, or that it's one of your workspaces.",
                        scope.workspace.as_deref().unwrap_or("")
                    ),
                ));
            }
            Got::Refused(_, _, reason) => return Err(failed(reason)),
        }
    }
}

fn pick_workspace(workspaces: &[Value]) -> Result<String, Error> {
    let slugs: Vec<&str> = workspaces
        .iter()
        .filter_map(|w| w["slug"].as_str())
        .collect();
    let unclear = || {
        Error::new(
            "WORKSPACE_UNCLEAR",
            if slugs.is_empty() {
                "You're not in a workspace yet. Install RelayRunner's GitHub App on your account or organization, or ask an owner to accept your request, then run this again.".to_string()
            } else {
                format!("Name the workspace with --workspace: {}.", slugs.join(", "))
            },
        )
    };
    if !ui::can_ask() || workspaces.is_empty() {
        return Err(unclear());
    }
    let choices: Vec<ui::Choice> = workspaces
        .iter()
        .map(|w| ui::Choice {
            label: w["name"].as_str().unwrap_or("?").to_string(),
            hint: w["slug"].as_str().map(str::to_string),
        })
        .collect();
    let index = ui::select("Which workspace?", &choices, 0).ok_or_else(unclear)?;
    workspaces[index]["id"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(unclear)
}

/// Where the dashboard shows an evaluation, in its workspace.
pub fn dashboard_url(server: &str, provider: &str, id: &str, workspace: &str) -> String {
    format!(
        "{}/providers/{}/evaluate?id={}&workspace={}",
        server.trim_end_matches('/'),
        encode(provider),
        encode(id),
        encode(workspace)
    )
}

// ---- The command ---------------------------------------------------------------------------------

/// Runs `eval` and answers its exit code.
/// `vm`: this machine runs Linux jobs in VMs, for the picker's warnings when a workflow is routed.
pub fn command(credentials: &Credentials, rest: &[String], vm: bool) -> Result<i32, Error> {
    let args = Args::parse(rest)?;
    if args.json {
        ui::use_stderr();
    }
    let mut scope = Scope {
        workspace: args.workspace.clone(),
        owner: None,
    };
    match args.action {
        Action::List => list(credentials, &args, &mut scope),
        Action::Stop => {
            let id = args.target.as_deref().unwrap_or_default();
            match call(
                credentials,
                "POST",
                &format!("/{}/cancel", encode(id)),
                &scope,
                None,
            )? {
                Got::Ok(_) => {
                    ui::success("Stopped. Runs that finished stay in its comparison.");
                    Ok(0)
                }
                Got::Unclear(workspaces) => {
                    scope.workspace = Some(pick_workspace(&workspaces)?);
                    command_stop_again(credentials, id, &scope)
                }
                Got::Refused(_, code, reason) => Err(refusal(&code, reason)),
            }
        }
        Action::Watch => {
            let id = match args.target.clone() {
                Some(id) => id,
                None => running_one(credentials, &mut scope)?,
            };
            ui::intro("Evaluation");
            let report = get(credentials, &format!("/{}", encode(&id)), &mut scope)?;
            let workspace = resolved_workspace(credentials, &mut scope, &report)?;
            ui::info(&format!(
                "Watch it in the dashboard too:\n{}",
                dashboard_url(
                    &credentials.server,
                    str_of(&report["provider"]),
                    &id,
                    &workspace
                )
            ));
            Ok(watch(credentials, &args, &mut scope, &id, &workspace, None))
        }
        Action::Start => start(credentials, &args, &mut scope, vm),
    }
}

fn command_stop_again(credentials: &Credentials, id: &str, scope: &Scope) -> Result<i32, Error> {
    match call(
        credentials,
        "POST",
        &format!("/{}/cancel", encode(id)),
        scope,
        None,
    )? {
        Got::Ok(_) => {
            ui::success("Stopped. Runs that finished stay in its comparison.");
            Ok(0)
        }
        Got::Unclear(_) => Err(failed("the workspace couldn't be told".into())),
        Got::Refused(_, code, reason) => Err(refusal(&code, reason)),
    }
}

fn refusal(code: &str, reason: String) -> Error {
    match code {
        "FORBIDDEN" => Error::new(
            "FORBIDDEN",
            "Only owners and admins can start or stop an evaluation. You can still watch one with `relayrunner eval watch`.",
        ),
        "NOT_FOUND" => Error::new(
            "NOT_FOUND",
            "There's no evaluation with that id in this workspace.",
        ),
        _ => failed(reason),
    }
}

/// The workspace's slug for links: the one named, or the one the gateway answered for.
fn resolved_workspace(
    credentials: &Credentials,
    scope: &mut Scope,
    report: &Value,
) -> Result<String, Error> {
    let provider = str_of(&report["provider"]);
    let app = get(
        credentials,
        &format!("/provider-app?provider={}", encode(provider)),
        scope,
    )?;
    let slug = app["workspace"]["slug"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    if let Some(id) = app["workspace"]["id"].as_str() {
        scope.workspace = Some(id.to_string());
    }
    Ok(slug)
}

fn running_one(credentials: &Credentials, scope: &mut Scope) -> Result<String, Error> {
    let body = get(credentials, "", scope)?;
    let active: Vec<&Value> = body["evaluations"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|e| matches!(str_of(&e["state"]), "dispatching" | "waiting" | "running"))
        .collect();
    match active.as_slice() {
        [] => Err(Error::new(
            "NOT_FOUND",
            "Nothing is being evaluated now. Start one with `relayrunner eval <provider>`.",
        )),
        [one] => Ok(str_of(&one["id"]).to_string()),
        many => {
            let choices: Vec<ui::Choice> = many
                .iter()
                .map(|e| ui::Choice {
                    label: format!("{} · {}", str_of(&e["repository"]), workflow_title(e)),
                    hint: Some(str_of(&e["provider"]).to_string()),
                })
                .collect();
            let index = ui::select("Which evaluation?", &choices, 0).ok_or_else(|| {
                Error::new(
                    "USAGE",
                    "More than one is running. Pass its id: `relayrunner eval watch <id>`.",
                )
            })?;
            Ok(str_of(&many[index]["id"]).to_string())
        }
    }
}

fn list(credentials: &Credentials, args: &Args, scope: &mut Scope) -> Result<i32, Error> {
    let provider = args.provider.clone().or_else(|| args.target.clone());
    let path = match &provider {
        Some(p) => format!("/recent?provider={}", encode(p)),
        None => String::new(),
    };
    let body = get(credentials, &path, scope)?;
    let rows = body["evaluations"].as_array().cloned().unwrap_or_default();
    if args.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&rows).expect("serializes")
        );
        return Ok(0);
    }
    if rows.is_empty() {
        println!("No evaluations in the last 30 days.");
        return Ok(0);
    }
    let now = now_ms();
    for row in &rows {
        let attempt = row["attempt"].as_u64().unwrap_or(0);
        let runs = row["runs"].as_u64().unwrap_or(5);
        let state = match str_of(&row["state"]) {
            "done" => "done".to_string(),
            "failed" => "failed".to_string(),
            "cancelled" => format!("stopped at {attempt} of {runs}"),
            "waiting" => "waiting for workflow_dispatch".to_string(),
            _ => format!("run {attempt} of {runs}"),
        };
        let age = crate::history::ago(now.saturating_sub(row["createdAt"].as_u64().unwrap_or(now)));
        println!(
            "{}  {:<10} {} · {}  {}  {}",
            str_of(&row["id"]).chars().take(8).collect::<String>(),
            str_of(&row["provider"]),
            str_of(&row["repository"]),
            workflow_title(row),
            state,
            age
        );
    }
    Ok(0)
}

fn start(
    credentials: &Credentials,
    args: &Args,
    scope: &mut Scope,
    vm: bool,
) -> Result<i32, Error> {
    let can_ask = ui::can_ask() && !args.json;
    let repo = args.repo.clone().or_else(current_repo);
    scope.owner = repo
        .as_deref()
        .and_then(|r| r.split_once('/'))
        .map(|(owner, _)| owner.to_string());

    // The provider: named, or picked from the ones an evaluation can run on.
    let providers = get(credentials, "/providers", scope)?["providers"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let ids: Vec<&str> = providers.iter().map(|p| str_of(&p["id"])).collect();
    let provider = match args.target.as_deref() {
        Some(wanted) => providers
            .iter()
            .find(|p| {
                str_of(&p["id"]).eq_ignore_ascii_case(wanted)
                    || str_of(&p["name"]).eq_ignore_ascii_case(wanted)
            })
            .cloned()
            .ok_or_else(|| {
                Error::new(
                    "USAGE",
                    format!(
                        "{wanted} can't be evaluated. Pick one of: {}.",
                        ids.join(", ")
                    ),
                )
            })?,
        None if can_ask => {
            let choices: Vec<ui::Choice> = providers
                .iter()
                .map(|p| ui::Choice {
                    label: str_of(&p["name"]).to_string(),
                    hint: None,
                })
                .collect();
            let index = ui::select("Which provider do you want to evaluate?", &choices, 0)
                .ok_or_else(cancelled)?;
            providers[index].clone()
        }
        None => {
            return Err(Error::new(
                "USAGE",
                format!("Name the provider: relayrunner eval <{}>.", ids.join("|")),
            ));
        }
    };
    let id = str_of(&provider["id"]).to_string();
    let name = str_of(&provider["name"]).to_string();
    ui::intro(&format!("Evaluate {name}"));

    // Step 1: the provider's GitHub App on the workspace's account.
    let mut app = get(
        credentials,
        &format!("/provider-app?provider={}", encode(&id)),
        scope,
    )?;
    if let Some(ws) = app["workspace"]["id"].as_str() {
        scope.workspace = Some(ws.to_string());
    }
    let workspace_slug = str_of(&app["workspace"]["slug"]).to_string();
    let account = app["account"]["login"]
        .as_str()
        .unwrap_or("your account")
        .to_string();
    ui::step(&format!(
        "Workspace {}{}",
        str_of(&app["workspace"]["name"]),
        if args.workspace.is_none() && scope.owner.is_some() {
            paint(Style::Gray, " · from this repo's GitHub account")
        } else {
            String::new()
        }
    ));
    if app["canStart"] != json!(true) {
        ui::error(
            "Only owners and admins can start an evaluation. You can still watch one with `relayrunner eval watch`.",
        );
        return Ok(NEEDS_YOU);
    }
    let connect_url = provider["connectUrl"].as_str().map(str::to_string);
    let steps = format!(
        "1. Sign up for {name}\n2. Install the {name} GitHub App on {account}{}",
        connect_url
            .as_deref()
            .map(|u| format!("\n{u}"))
            .unwrap_or_default()
    );
    match app["installed"].as_bool() {
        Some(true) => ui::step(&format!("{name}'s GitHub App is installed on {account}")),
        Some(false) => {
            ui::warn(&format!(
                "{name}'s GitHub App isn't on {account} yet.\n{steps}"
            ));
            if args.yes || !can_ask {
                return Ok(NEEDS_YOU);
            }
            if let Some(url) = &connect_url
                && ui::confirm(&format!("Open {name} in your browser?"), true) == Some(true)
            {
                crate::login::open_browser(url);
            }
            let keys = Keys::start();
            ui::spinner(&format!(
                "Looking for the {name} app on {account}… checks every 10s · Ctrl-C to stop"
            ));
            loop {
                if keys.wait(APP_POLL) == Some(Key::Quit) {
                    ui::stop_spinner("Stopped looking", false);
                    return Ok(INTERRUPTED);
                }
                app = get(
                    credentials,
                    &format!("/provider-app?provider={}", encode(&id)),
                    scope,
                )?;
                if app["installed"] == json!(true) {
                    break;
                }
            }
            drop(keys);
            ui::stop_spinner(
                &format!("{name}'s GitHub App is installed on {account}"),
                true,
            );
        }
        None => {
            ui::info(&format!(
                "{name} needs its GitHub App on {account}. GitHub doesn't show which apps are on {account}, so confirm this step yourself.\n{steps}"
            ));
            if args.yes || !can_ask {
                ui::warn(&format!(
                    "Going on without checking. If {name}'s app isn't installed, run 1 fails at Set up runner."
                ));
            } else {
                loop {
                    let choices = [
                        ui::Choice {
                            label: "Yes, it's installed".into(),
                            hint: None,
                        },
                        ui::Choice {
                            label: format!("Open {name} to set it up"),
                            hint: None,
                        },
                        ui::Choice {
                            label: "Cancel".into(),
                            hint: None,
                        },
                    ];
                    match ui::select(
                        &format!("Is {name}'s app installed on {account}?"),
                        &choices,
                        0,
                    ) {
                        Some(0) => break,
                        Some(1) => {
                            if let Some(url) = &connect_url {
                                crate::login::open_browser(url);
                            }
                        }
                        _ => return Err(cancelled()),
                    }
                }
            }
        }
    }

    // Step 2: the workflow. In a clone of the repo, its workflow files are listed too, so a
    // workflow can be picked before any of its runs reached RelayRunner.
    let mut workflows = get(credentials, "/workflows", scope)?["workflows"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let checkout = repo
        .as_deref()
        .and_then(|repo| crate::init::checkout_of(repo, vm));
    if let (Some(repo), Some(checkout)) = (&repo, &checkout) {
        add_local(&mut workflows, repo, &checkout.workflows);
    }
    if workflows.is_empty() && repo.is_none() {
        // A new account: RelayRunner only sees runs from after its GitHub App was installed.
        ui::error(
            "No workflow runs have reached RelayRunner yet. It sees runs from after its GitHub App was installed.",
        );
        ui::info(
            "Run this in a clone of the repo to pick one of its workflows, or name it with --repo.",
        );
        return Ok(NEEDS_YOU);
    }
    let repo = match repo {
        Some(repo) => repo,
        None => pick_repo(&workflows, can_ask)?,
    };
    let in_repo: Vec<&Value> = workflows
        .iter()
        .filter(|w| str_of(&w["repository"]).eq_ignore_ascii_case(&repo))
        .collect();
    if in_repo.is_empty() {
        ui::error(&format!(
            "No workflows in {repo} ran in the last 14 days that this workspace can see."
        ));
        ui::info(
            "Check --repo and --workspace, or run this in a clone of the repo to pick one of its workflows.",
        );
        return Ok(NEEDS_YOU);
    }
    let workflow = match &args.workflow {
        Some(wanted) => in_repo
            .iter()
            .find(|w| matches_workflow(w, wanted))
            .copied()
            .ok_or_else(|| {
                Error::new(
                    "USAGE",
                    format!(
                        "{repo} has no workflow {wanted}. Its workflows: {}.",
                        in_repo
                            .iter()
                            .map(|w| file_of(str_of(&w["path"])))
                            .collect::<Vec<_>>()
                            .join(", ")
                    ),
                )
            })?,
        None if can_ask => {
            let choices: Vec<ui::Choice> = in_repo.iter().map(|w| workflow_choice(w)).collect();
            let index = ui::select(&format!("Which workflow in {repo}?"), &choices, 0)
                .ok_or_else(cancelled)?;
            in_repo[index]
        }
        None => {
            return Err(Error::new(
                "USAGE",
                format!(
                    "Name the workflow with --workflow: {}.",
                    in_repo
                        .iter()
                        .map(|w| file_of(str_of(&w["path"])))
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            ));
        }
    };
    let mut workflow = workflow.clone();
    let title = workflow_title(&workflow);
    let path = str_of(&workflow["path"]).to_string();
    let file = file_of(&path).to_string();

    // A workflow with no runs yet: its repo's id, from the repos the GitHub App can see.
    let mut seen_default: Option<String> = None;
    if workflow["repositoryId"].is_null() {
        match call(
            credentials,
            "GET",
            &format!("/repos?name={}", encode(&repo)),
            scope,
            None,
        )? {
            Got::Ok(found) => {
                workflow["repositoryId"] = found["id"].clone();
                seen_default = found["defaultBranch"].as_str().map(str::to_string);
            }
            Got::Refused(404, _, _) => {
                ui::error(&format!(
                    "RelayRunner's GitHub App can't see {repo}. Give it access to the repo on GitHub, then run this again."
                ));
                return Ok(NEEDS_YOU);
            }
            Got::Refused(_, _, reason) => return Err(failed(reason)),
            Got::Unclear(_) => return Err(failed("the workspace couldn't be told".into())),
        }
    }

    // Jobs that don't go through a relay yet: route them here, with init's picker.
    let mut waiting_for: Option<String> = None;
    if workflow["relayed"] == json!(false) {
        let again = format!("relayrunner eval {id} --workflow {file}");
        let local = checkout
            .as_ref()
            .filter(|c| c.workflows.iter().any(|w| w.path == path));
        let Some(local) = local.filter(|_| can_ask && !args.yes) else {
            ui::warn(&format!(
                "{title}'s jobs don't go through RelayRunner yet, so an evaluation can't steer them.\nRun `relayrunner init` in this repo to route them. Where they run today doesn't change."
            ));
            ui::outro(&format!("Then run `{again}` again."));
            return Ok(NEEDS_YOU);
        };
        ui::warn(&format!(
            "{title}'s jobs don't go through RelayRunner yet, so an evaluation can't steer them. Where they run today doesn't change."
        ));
        if ui::confirm(&format!("Route {file}'s jobs now?"), true) != Some(true) {
            ui::outro(&format!(
                "Route them with `relayrunner init`, then run `{again}` again."
            ));
            return Ok(NEEDS_YOU);
        }
        let before = crate::push::before_edit(&local.root);
        let edit = match crate::init::route_for_eval(local, &path) {
            Ok(Some(edit)) => edit,
            Ok(None) => {
                ui::outro("Nothing changed.");
                return Ok(NEEDS_YOU);
            }
            Err(message) => {
                ui::error(&message);
                return Ok(NEEDS_YOU);
            }
        };
        let default = crate::push::default_branch(&local.root, seen_default.as_deref())
            .unwrap_or_else(|| "main".to_string());
        let pushed = if ui::confirm("Commit and push it?", true) == Some(true) {
            match crate::push::push(
                &local.root,
                &repo,
                &default,
                &path,
                &edit.before,
                &edit.after,
                &format!("ci: route {file} through RelayRunner"),
                &before,
            ) {
                Ok(pushed) => Some(pushed),
                Err(message) => {
                    ui::warn(&message);
                    None
                }
            }
        } else {
            None
        };
        let on_default = matches!(pushed, Some(crate::push::Pushed::Default));
        match pushed {
            Some(crate::push::Pushed::Default) => {
                ui::success(&format!("Pushed the change to {default}"));
                waiting_for = Some(format!(
                    "The evaluation starts once GitHub sees {file}'s new version on {default}."
                ));
            }
            Some(crate::push::Pushed::Branch { branch, compare }) => {
                ui::success(&format!("Pushed the change to {branch}"));
                ui::info(&format!(
                    "Open a pull request and merge it into {default}:\n{compare}"
                ));
                waiting_for = Some(format!(
                    "The evaluation starts once the pull request is merged into {default}."
                ));
            }
            None => {
                ui::info(&format!("Commit {path} and push it to {default}."));
                waiting_for = Some(format!(
                    "The evaluation starts once the change is on {default}."
                ));
            }
        }
        // A workflow that can already be started on demand would start today's version, whose
        // jobs aren't routed, so it's started once the change is in.
        if !on_default && edit.dispatchable {
            ui::outro(&format!(
                "Once the change is on {default}, run `{again}` again."
            ));
            return Ok(NEEDS_YOU);
        }
    }

    // Step 3: the size, then what happens.
    let sizes = provider["sizes"].as_array().cloned().unwrap_or_default();
    let wanted = args.vcpus.unwrap_or(DEFAULT_VCPUS);
    let size = sizes
        .iter()
        .find(|s| s["vcpus"].as_u64() == Some(wanted))
        .or(if args.vcpus.is_none() {
            sizes.first()
        } else {
            None
        })
        .ok_or_else(|| {
            Error::new(
                "USAGE",
                format!(
                    "{name} doesn't offer {wanted} vCPUs. Pick --vcpus {}.",
                    sizes
                        .iter()
                        .filter_map(|s| s["vcpus"].as_u64())
                        .map(|n| n.to_string())
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            )
        })?;
    let vcpus = size["vcpus"].as_u64().unwrap_or(wanted);
    ui::step(&format!(
        "Machine {vcpus} vCPU Linux{}",
        paint(Style::Gray, &format!(" · {}", str_of(&size["label"])))
    ));
    let total = workflow["medianMs"]
        .as_u64()
        .map(|ms| format!(", about {} in all", about(ms * 5)))
        .unwrap_or_default();
    ui::message(&format!(
        "{title} runs 5 times on {name} from the default branch{total}.\nSame commit each time: cold cache first, then warm. The evaluation doesn't change the repo.\nThe runs bill to your {name} account."
    ));
    if !args.yes {
        if !can_ask {
            return Err(Error::new(
                "USAGE",
                "Pass --yes to start an evaluation without being asked.",
            ));
        }
        if ui::confirm("Start 5 runs?", true) != Some(true) {
            return Err(cancelled());
        }
    }

    // Step 4: start, then follow it.
    let body = json!({
        "repositoryId": workflow["repositoryId"],
        "workflowPath": workflow["path"],
        "workflowName": workflow["workflow"],
        "provider": id,
        "vcpus": vcpus,
    });
    let evaluation = match call(credentials, "POST", "", scope, Some(&body))? {
        Got::Ok(body) => str_of(&body["id"]).to_string(),
        Got::Refused(409, code, _) if code == "EVALUATION_ACTIVE" => {
            let running = get(credentials, &format!("?provider={}", encode(&id)), scope)
                .ok()
                .and_then(|b| {
                    b["evaluations"].as_array().and_then(|list| {
                        list.iter()
                            .find(|e| {
                                e["workflowPath"] == workflow["path"]
                                    && matches!(
                                        str_of(&e["state"]),
                                        "dispatching" | "waiting" | "running"
                                    )
                            })
                            .map(|e| str_of(&e["id"]).to_string())
                    })
                });
            ui::warn(&format!("{title} is already being evaluated."));
            match running {
                Some(running)
                    if args.yes
                        || (can_ask
                            && ui::confirm("Watch that one instead?", true) == Some(true)) =>
                {
                    running
                }
                _ => return Ok(NEEDS_YOU),
            }
        }
        Got::Refused(403, _, _) => {
            ui::error("Only owners and admins can start an evaluation.");
            return Ok(NEEDS_YOU);
        }
        Got::Refused(_, _, reason) => return Err(failed(reason)),
        Got::Unclear(_) => return Err(failed("the workspace couldn't be told".into())),
    };
    let url = dashboard_url(&credentials.server, &id, &evaluation, &workspace_slug);
    if args.detach {
        if args.json {
            println!("{}", json!({ "id": evaluation, "url": url }));
        } else {
            ui::outro(&format!(
                "Started {evaluation}. Follow it with `relayrunner eval watch {evaluation}`.\n   {url}"
            ));
        }
        return Ok(0);
    }
    ui::info(&format!("Started. Watch it in the dashboard too:\n{url}"));
    Ok(watch(
        credentials,
        args,
        scope,
        &evaluation,
        &workspace_slug,
        waiting_for.as_deref(),
    ))
}

fn cancelled() -> Error {
    Error::new("CANCELLED", "Cancelled. Nothing was started.")
}

fn pick_repo(workflows: &[Value], can_ask: bool) -> Result<String, Error> {
    let mut repos: Vec<String> = Vec::new();
    for w in workflows {
        let r = str_of(&w["repository"]).to_string();
        if !repos.contains(&r) {
            repos.push(r);
        }
    }
    if repos.is_empty() {
        return Err(Error::new(
            "NO_WORKFLOWS",
            "No workflows ran in this workspace's repos in the last 14 days.",
        ));
    }
    if !can_ask {
        return Err(Error::new(
            "USAGE",
            format!("Name the repository with --repo: {}.", repos.join(", ")),
        ));
    }
    let choices: Vec<ui::Choice> = repos
        .iter()
        .map(|r| ui::Choice {
            label: r.clone(),
            hint: None,
        })
        .collect();
    let index = ui::select("Which repository?", &choices, 0).ok_or_else(cancelled)?;
    Ok(repos[index].clone())
}

/// Whether `wanted` names this workflow: its path, its file name, or its name.
pub fn matches_workflow(workflow: &Value, wanted: &str) -> bool {
    let path = str_of(&workflow["path"]);
    path == wanted
        || file_of(path).eq_ignore_ascii_case(wanted)
        || workflow["workflow"]
            .as_str()
            .is_some_and(|name| name.eq_ignore_ascii_case(wanted))
}

/// Adds the checkout's workflow files to the workflows that ran, by path. Whether each is routed
/// comes from the file, which may be ahead of its runs. Files with no runs go last, with no
/// `repositoryId` when no other workflow of the repo ran either.
pub fn add_local(workflows: &mut Vec<Value>, repo: &str, local: &[crate::init::LocalWorkflow]) {
    let in_repo = |w: &Value| str_of(&w["repository"]).eq_ignore_ascii_case(repo);
    let repository_id = workflows
        .iter()
        .find(|w| in_repo(w))
        .map(|w| w["repositoryId"].clone())
        .unwrap_or(Value::Null);
    for file in local {
        match workflows
            .iter_mut()
            .find(|w| in_repo(w) && str_of(&w["path"]) == file.path)
        {
            Some(known) => known["relayed"] = json!(file.routed),
            None => workflows.push(json!({
                "repositoryId": repository_id,
                "repository": repo,
                "workflow": file.name,
                "path": file.path,
                "runs": 0,
                "baselineRuns": 0,
                "medianMs": null,
                "relayed": file.routed,
                "dispatched": false,
            })),
        }
    }
}

fn workflow_choice(w: &Value) -> ui::Choice {
    let file = file_of(str_of(&w["path"]));
    let hint = if w["relayed"] == json!(false) {
        format!("{file} · not routed through a relay yet")
    } else if w["runs"].as_u64() == Some(0) {
        format!("{file} · no runs in 14 days")
    } else {
        let runs = w["runs"].as_u64().unwrap_or(0);
        let typical = w["medianMs"]
            .as_u64()
            .map(|ms| format!(" · typically {}", duration(ms)))
            .unwrap_or_default();
        format!("{file} · {runs} runs in 14 days{typical}")
    };
    ui::Choice {
        label: workflow_title(w),
        hint: Some(hint),
    }
}

// ---- Following one -------------------------------------------------------------------------------

#[derive(Debug, PartialEq, Clone, Copy)]
enum Key {
    Stop,
    Open,
    Retry,
    Quit,
}

/// Keys one at a time while an evaluation is followed: s stops it, o opens the dashboard, r tries
/// a waiting dispatch again, and Ctrl-C leaves it running.
struct Keys {
    rx: Option<Receiver<Key>>,
}

static RAW: Mutex<Option<ui::RawMode>> = Mutex::new(None);

impl Keys {
    fn start() -> Keys {
        if !ui::can_ask() {
            return Keys { rx: None };
        }
        let Some(raw) = ui::RawMode::start() else {
            return Keys { rx: None };
        };
        *RAW.lock().unwrap() = Some(raw);
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut stdin = std::io::stdin().lock();
            let mut byte = [0u8; 1];
            while stdin.read(&mut byte).unwrap_or(0) == 1 {
                let key = match byte[0] {
                    b's' | b'S' => Key::Stop,
                    b'o' | b'O' => Key::Open,
                    b'r' | b'R' => Key::Retry,
                    3 | 4 => Key::Quit,
                    _ => continue,
                };
                if tx.send(key).is_err() {
                    break;
                }
            }
        });
        Keys { rx: Some(rx) }
    }

    /// Waits up to `timeout` for a key. Without a terminal it just waits.
    fn wait(&self, timeout: Duration) -> Option<Key> {
        match &self.rx {
            Some(rx) => rx.recv_timeout(timeout).ok(),
            None => {
                std::thread::sleep(timeout);
                None
            }
        }
    }

    fn on(&self) -> bool {
        self.rx.is_some()
    }
}

impl Drop for Keys {
    fn drop(&mut self) {
        RAW.lock().unwrap().take();
    }
}

/// What's drawn under the log. On a terminal it's redrawn in place; off one (a pipe or a CI log)
/// only each job's changes print, one line each.
struct LiveArea {
    lines: usize,
    tty: bool,
    /// Off a terminal, the state each job was last printed in, by run and job id.
    seen: HashMap<(u64, u64), String>,
}

impl LiveArea {
    fn new() -> LiveArea {
        LiveArea {
            lines: 0,
            tty: ui::interactive(),
            seen: HashMap::new(),
        }
    }

    fn draw(&mut self, report: &Value, lines: &[String]) {
        if self.tty {
            let mut out = String::new();
            if self.lines > 0 {
                out.push_str(&format!("\x1b[{}A\x1b[J", self.lines));
            }
            for line in lines {
                out.push_str(line);
                out.push('\n');
            }
            self.lines = lines.len();
            ui::write(&out);
            return;
        }
        for attempt in report["attempts"].as_array().into_iter().flatten() {
            let n = attempt["attempt"].as_u64().unwrap_or(0);
            for job in attempt["jobs"].as_array().into_iter().flatten() {
                let state = match (str_of(&job["status"]), str_of(&job["conclusion"])) {
                    ("done", "success") => "passed".to_string(),
                    ("done", conclusion) => conclusion.replace('_', " "),
                    (status, _) => status.to_string(),
                };
                let key = (n, job["id"].as_u64().unwrap_or(0));
                if self.seen.get(&key) != Some(&state) {
                    ui::write(&format!("Run {n}  {}  {state}\n", str_of(&job["name"])));
                    self.seen.insert(key, state);
                }
            }
        }
    }

    fn clear(&mut self) {
        if self.tty && self.lines > 0 {
            ui::write(&format!("\x1b[{}A\x1b[J", self.lines));
        }
        self.lines = 0;
    }
}

/// Follows an evaluation until it ends, and answers the exit code. `waiting_for` says what a
/// waiting one waits for, when this run of `eval` made the change itself.
fn watch(
    credentials: &Credentials,
    args: &Args,
    scope: &mut Scope,
    id: &str,
    workspace: &str,
    waiting_for: Option<&str>,
) -> i32 {
    let keys = Keys::start();
    let mut area = LiveArea::new();
    let mut finished_shown = 0usize;
    let mut waiting_shown = false;
    // The running attempt, when it was first seen here, and how long its jobs had taken by then.
    let mut clock: Option<(u64, Instant, u64)> = None;
    let mut retried = Instant::now();
    let path = format!("/{}", encode(id));
    ui::write(&format!("{}\n", paint(Style::Gray, "│")));
    loop {
        let report = match get(credentials, &path, scope) {
            Ok(report) => report,
            Err(error) => {
                area.clear();
                drop(keys);
                ui::error(&error.message);
                return 1;
            }
        };
        let state = str_of(&report["state"]).to_string();
        let provider = str_of(&report["provider"]).to_string();
        let url = dashboard_url(&credentials.server, &provider, id, workspace);

        // Finished runs go into the log once each.
        let attempts = report["attempts"].as_array().cloned().unwrap_or_default();
        let done: Vec<&Value> = attempts
            .iter()
            .filter(|a| str_of(&a["status"]) == "done")
            .collect();
        if done.len() > finished_shown {
            area.clear();
            for attempt in &done[finished_shown..] {
                ui::write(&format!("{}\n", finished_line(attempt, &report)));
            }
            finished_shown = done.len();
        }

        if state == "waiting" && retried.elapsed() >= RETRY {
            retried = Instant::now();
            let _ = call(credentials, "POST", &format!("{path}/retry"), scope, None);
        }
        match state.as_str() {
            "waiting" if !waiting_shown && waiting_for.is_some() => {
                area.clear();
                waiting_shown = true;
                ui::info(&format!(
                    "{} It's tried again every 30s.",
                    waiting_for.unwrap_or_default()
                ));
            }
            "waiting" if !waiting_shown => {
                area.clear();
                waiting_shown = true;
                let path = str_of(&report["workflowPath"]);
                let r#ref = str_of(&report["ref"]);
                ui::warn(&format!(
                    "{} can't be started on demand yet. Add workflow_dispatch to its triggers on {}:\n\n  on:\n    {}\n    # …the triggers it already has\n\nEdit it on GitHub: https://github.com/{}/edit/{}/{}",
                    workflow_title(&report),
                    r#ref,
                    paint(Style::Green, "workflow_dispatch:"),
                    str_of(&report["repository"]),
                    encode(r#ref),
                    path
                ));
                if args.yes || !keys.on() {
                    ui::outro(&format!(
                        "It starts with the next push to {} that runs it, for up to a day.\n   {url}",
                        r#ref
                    ));
                    return NEEDS_YOU;
                }
            }
            "done" | "failed" | "cancelled" => {
                area.clear();
                drop(keys);
                return finish(credentials, args, scope, &report, &url, workspace);
            }
            _ => {}
        }

        // The run going now, timed from when it was first seen here, started at the longest
        // its jobs had taken by then.
        if let Some(current) = attempts.iter().find(|a| str_of(&a["status"]) != "done") {
            let n = current["attempt"].as_u64().unwrap_or(0);
            if clock.as_ref().is_none_or(|c| c.0 != n) {
                let seed = current["jobs"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|j| {
                        Some(j["split"]["waitMs"].as_u64()? + j["split"]["runMs"].as_u64()?)
                    })
                    .max()
                    .unwrap_or(0);
                clock = Some((n, Instant::now(), seed));
            }
        }
        let mut hint = None;
        if keys.on() {
            let finished = done
                .iter()
                .filter(|a| str_of(&a["conclusion"]) == "success")
                .count();
            let stop = match finished {
                0 => "s stop".to_string(),
                1 => "s stop at 1 run".to_string(),
                n => format!("s stop at {n} runs"),
            };
            let retry = if state == "waiting" {
                " · r try again now"
            } else {
                ""
            };
            hint = Some(format!(
                "{}  {}",
                paint(Style::Gray, "└"),
                paint(
                    Style::Gray,
                    &format!("{stop} · o open in browser{retry} · Ctrl-C leave it running"),
                )
            ));
        }

        // Redrawn every second for the clock, read again every POLL.
        let polled = Instant::now();
        let mut pressed = None;
        while pressed.is_none() && polled.elapsed() < POLL {
            let elapsed = clock
                .as_ref()
                .map(|(_, since, seed)| seed + since.elapsed().as_millis() as u64);
            let mut lines = live_lines(&report, elapsed);
            lines.extend(hint.clone());
            area.draw(&report, &lines);
            if !area.tty {
                pressed = keys.wait(POLL);
                break;
            }
            pressed = keys.wait(TICK);
        }

        match pressed {
            Some(Key::Quit) => {
                area.clear();
                drop(keys);
                ui::outro(&format!(
                    "Left it running. Follow it again with `relayrunner eval watch {id}`.\n   {url}"
                ));
                return INTERRUPTED;
            }
            Some(Key::Open) => crate::login::open_browser(&url),
            Some(Key::Retry) => {
                let _ = call(credentials, "POST", &format!("{path}/retry"), scope, None);
            }
            Some(Key::Stop) => {
                area.clear();
                match call(credentials, "POST", &format!("{path}/cancel"), scope, None) {
                    Ok(Got::Ok(_)) => {}
                    Ok(Got::Refused(_, code, reason)) => ui::error(&refusal(&code, reason).message),
                    Ok(Got::Unclear(_)) => {}
                    Err(error) => ui::error(&error.message),
                }
            }
            None => {}
        }
    }
}

/// The width of a finished run's label, "Run 1 of 5 · cold cache", so its numbers line up.
const LABEL: usize = 23;

/// "◇  Run 2 of 5               3m 58s  passed  $0.05".
fn finished_line(attempt: &Value, report: &Value) -> String {
    let n = attempt["attempt"].as_u64().unwrap_or(0);
    let runs = report["runs"].as_u64().unwrap_or(5);
    let plain = format!("Run {n} of {runs}");
    let (label, width) = if n == 1 {
        let cold = " · cold cache";
        (
            format!("{plain}{}", paint(Style::Gray, cold)),
            plain.chars().count() + cold.chars().count(),
        )
    } else {
        (plain.clone(), plain.chars().count())
    };
    let pad = " ".repeat(LABEL.saturating_sub(width));
    let ok = str_of(&attempt["conclusion"]) == "success";
    let result = if ok {
        paint(Style::Green, "passed")
    } else {
        paint(
            Style::Red,
            match str_of(&attempt["conclusion"]) {
                "failure" => "failed",
                "cancelled" => "cancelled",
                "timed_out" => "timed out",
                other => other,
            },
        )
    };
    let ms = format!(
        "{:>7}",
        attempt["ms"].as_u64().map(duration).unwrap_or_default()
    );
    let usd = attempt["usd"].as_f64().map(money).unwrap_or_default();
    let mark = if ok {
        paint(Style::Green, "◇")
    } else {
        paint(Style::Red, "■")
    };
    format!(
        "{mark}  {label}{pad} {}  {result}  {}",
        paint(Style::Bold, &ms),
        paint(Style::Gray, &usd)
    )
    .trim_end()
    .to_string()
}

/// The run going now and its jobs. `elapsed` is how long the run has been going, when known.
fn live_lines(report: &Value, elapsed: Option<u64>) -> Vec<String> {
    let bar = paint(Style::Gray, "│");
    let runs = report["runs"].as_u64().unwrap_or(5);
    let attempts = report["attempts"].as_array().cloned().unwrap_or_default();
    let state = str_of(&report["state"]);
    // The first attempt that isn't done: the later ones are "waiting" until it ends.
    let Some(current) = attempts.iter().find(|a| str_of(&a["status"]) != "done") else {
        let what = match state {
            "dispatching" => "Asking GitHub to start the run…",
            "waiting" => {
                "Waiting for workflow_dispatch on the default branch… tries again every 30s"
            }
            _ => "Waiting for GitHub to queue the run…",
        };
        return vec![format!("{}  {what}", paint(Style::Cyan, "◐"))];
    };
    let n = current["attempt"].as_u64().unwrap_or(1);
    let jobs = current["jobs"].as_array().cloned().unwrap_or_default();
    let done = jobs
        .iter()
        .filter(|j| str_of(&j["status"]) == "done")
        .count();
    let running = jobs
        .iter()
        .filter(|j| str_of(&j["status"]) == "running")
        .count();
    let width = 14usize;
    let total = jobs.len().max(1);
    let full = done * width / total;
    let part = (running * width / total).min(width - full);
    let meter = format!(
        "[{}{}{}]",
        paint(Style::Green, &"█".repeat(full)),
        paint(Style::Yellow, &"█".repeat(part)),
        paint(Style::Gray, &"░".repeat(width - full - part))
    );
    let finished = attempts
        .iter()
        .filter(|a| str_of(&a["status"]) == "done")
        .count() as u64;
    let per_run = report["warm"]["ms"]
        .as_u64()
        .or(report["cold"]["ms"].as_u64())
        .or(report["baseline"]["medianMs"].as_u64());
    // What's left: the runs after this one, and the rest of this one.
    let left = per_run
        .map(|ms| {
            let after = ms * runs.saturating_sub(finished + 1);
            let this = ms.saturating_sub(elapsed.unwrap_or(0));
            format!(" · about {} left", about(after + this))
        })
        .unwrap_or_default();
    let status = match elapsed {
        Some(ms) => format!("{}{left}", duration(ms)),
        None => format!("{done} of {} jobs done{left}", jobs.len()),
    };
    let plain = format!("Run {n} of {runs}");
    let mut lines = vec![format!(
        "{}  {plain}  {meter} {}",
        paint(Style::Cyan, "◐"),
        paint(Style::Gray, &status)
    )];
    for job in &jobs {
        let name = str_of(&job["name"]);
        let named = format!("{name:<30}");
        let (mark, name, detail) = match (str_of(&job["status"]), str_of(&job["conclusion"])) {
            ("done", "success") => (
                paint(Style::Green, "✓"),
                named,
                split_text(&job["split"], false),
            ),
            ("done", "skipped") => (
                paint(Style::Gray, "–"),
                paint(Style::Gray, &named),
                "skipped".to_string(),
            ),
            ("done", other) => (
                paint(Style::Red, "✕"),
                named,
                format!("{}{}", other.replace('_', " "), split_suffix(&job["split"])),
            ),
            ("running", _) => (
                paint(Style::Yellow, "◐"),
                named,
                split_text(&job["split"], true),
            ),
            _ => (
                paint(Style::Gray, "○"),
                paint(Style::Gray, &named),
                "queued".to_string(),
            ),
        };
        lines.push(format!(
            "{bar}    {mark} {name} {}",
            paint(Style::Gray, &detail)
        ));
    }
    lines.push(bar);
    lines
}

fn split_text(split: &Value, running: bool) -> String {
    match (split["waitMs"].as_u64(), split["runMs"].as_u64()) {
        (Some(wait), Some(run)) => format!(
            "wait {} · {} {}",
            duration(wait),
            if running { "running" } else { "ran" },
            duration(run)
        ),
        _ if running => "running".to_string(),
        _ => String::new(),
    }
}

fn split_suffix(split: &Value) -> String {
    let text = split_text(split, false);
    if text.is_empty() {
        text
    } else {
        format!(" · {text}")
    }
}

// ---- The result ----------------------------------------------------------------------------------

fn finish(
    credentials: &Credentials,
    args: &Args,
    scope: &mut Scope,
    report: &Value,
    url: &str,
    workspace: &str,
) -> i32 {
    let state = str_of(&report["state"]);
    let passed = report["attempts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|a| str_of(&a["status"]) == "done" && str_of(&a["conclusion"]) == "success")
        .count();
    let code = match state {
        "done" => 0,
        "cancelled" if passed > 0 => 0,
        _ => 1,
    };
    if args.json {
        let mut out = report.clone();
        out["url"] = json!(url);
        println!(
            "{}",
            serde_json::to_string_pretty(&out).expect("serializes")
        );
        return code;
    }
    let provider = str_of(&report["provider"]);
    let name = provider_name(credentials, scope, provider);
    let runs = report["runs"].as_u64().unwrap_or(5);
    match state {
        "failed" => {
            ui::error(report["error"].as_str().unwrap_or("A run failed."));
            show_failures(credentials, args, scope, report, &name);
        }
        "cancelled" if passed == 0 => {
            ui::warn("Stopped before any run finished, so there's nothing to compare.");
        }
        "cancelled" => {
            ui::success(&format!(
                "Stopped after {passed} of {runs} runs of {}",
                workflow_title(report)
            ));
            ui::write(&comparison(report, &name));
        }
        _ => {
            ui::success(&format!(
                "{name} finished {runs} runs of {}",
                workflow_title(report)
            ));
            ui::write(&comparison(report, &name));
        }
    }
    if code == 0 {
        ui::message(&format!(
            "Put {name} in your Router: {}/router?workspace={}",
            credentials.server.trim_end_matches('/'),
            encode(workspace)
        ));
    }
    ui::outro(&format!("Full results: {url}"));
    code
}

/// The table under a finished evaluation: today, cold and warm, for the whole run and by job.
pub fn comparison(report: &Value, name: &str) -> String {
    let ms = |v: &Value| v.as_u64().map(duration).unwrap_or_else(|| "–".into());
    let usd = |v: &Value| v.as_f64().map(money).unwrap_or_else(|| "–".into());
    let baseline = &report["baseline"];
    let cold = &report["cold"];
    let warm = &report["warm"];
    let after = if warm["ms"].is_null() { cold } else { warm };
    let mut out = String::from("\n");
    out.push_str(&paint(
        Style::Gray,
        &format!(
            "    {:<18} {:>10} {:>12} {:>12}   Change\n",
            "",
            "Today",
            format!("{name} cold"),
            format!("{name} warm")
        ),
    ));
    out.push_str(&format!(
        "    {:<18} {:>10} {:>12} {:>12}   {}\n",
        "Whole run",
        ms(&baseline["medianMs"]),
        ms(&cold["ms"]),
        ms(&warm["ms"]),
        change(
            baseline["medianMs"].as_f64(),
            after["ms"].as_f64(),
            "faster",
            "slower"
        )
    ));
    out.push_str(&format!(
        "    {:<18} {:>10} {:>12} {:>12}\n",
        "  waiting",
        ms(&baseline["waitMs"]),
        ms(&cold["waitMs"]),
        ms(&warm["waitMs"])
    ));
    out.push_str(&format!(
        "    {:<18} {:>10} {:>12} {:>12}   {}\n",
        "Cost per run",
        usd(&baseline["usd"]),
        usd(&cold["usd"]),
        usd(&warm["usd"]),
        change(
            baseline["usd"].as_f64(),
            after["usd"].as_f64(),
            "cheaper",
            "more"
        )
    ));
    let baseline_runs = baseline["runs"].as_u64().unwrap_or(0);
    out.push_str(&paint(
        Style::Gray,
        &if baseline_runs == 0 {
            "    Today needs a passing run on the default branch to compare with.\n".to_string()
        } else {
            format!(
                "    Today = median of the last {baseline_runs} passing runs on {}.\n",
                str_of(&report["ref"])
            )
        },
    ));
    let jobs = report["jobs"].as_array().cloned().unwrap_or_default();
    if !jobs.is_empty() {
        out.push_str(&paint(
            Style::Gray,
            &format!("\n    {:<32} {:>10} {:>10}\n", "By job", "Today", name),
        ));
        for job in &jobs {
            let total = |split: &Value| match (split["waitMs"].as_u64(), split["runMs"].as_u64()) {
                (Some(w), Some(r)) => duration(w + r),
                _ => "–".into(),
            };
            let theirs = if job["warm"].is_null() {
                &job["cold"]
            } else {
                &job["warm"]
            };
            if job["onProvider"] == json!(false) {
                out.push_str(&format!(
                    "    {:<32} {:>10} {}\n",
                    str_of(&job["name"]),
                    total(&job["baseline"]),
                    paint(Style::Gray, "  not on a relay, ran on its usual runner")
                ));
            } else {
                out.push_str(&format!(
                    "    {:<32} {:>10} {:>10}\n",
                    str_of(&job["name"]),
                    total(&job["baseline"]),
                    total(theirs)
                ));
            }
        }
    }
    out.push('\n');
    out
}

/// "41% faster", or "" when either side is missing.
pub fn change(from: Option<f64>, to: Option<f64>, better: &str, worse: &str) -> String {
    match (from, to) {
        (Some(from), Some(to)) if from > 0.0 => {
            let pct = ((from - to) / from * 100.0).round();
            if pct > 0.0 {
                paint(Style::Green, &format!("{pct}% {better}"))
            } else if pct < 0.0 {
                paint(Style::Yellow, &format!("{}% {worse}", -pct))
            } else {
                "about the same".into()
            }
        }
        _ => String::new(),
    }
}

// GitHub's name for a self-hosted runner's job-started hook: the provider's own setup.
fn is_runner_setup(step: &str) -> bool {
    step.split_once(". ").is_some_and(|(n, rest)| {
        !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) && rest == "Set up runner"
    })
}

/// Why the run that ended it failed, job by job, as the Evaluate page shows it.
fn show_failures(
    credentials: &Credentials,
    args: &Args,
    scope: &mut Scope,
    report: &Value,
    name: &str,
) {
    let attempt = report["attempts"].as_array().and_then(|list| {
        list.iter().find(|a| {
            matches!(
                str_of(&a["conclusion"]),
                "failure" | "timed_out" | "cancelled"
            ) && str_of(&a["status"]) == "done"
        })
    });
    let Some(attempt) = attempt else { return };
    let repo = str_of(&report["repository"]);
    let run_id = report["runId"].as_u64().unwrap_or(0);
    for job in attempt["jobs"].as_array().into_iter().flatten() {
        if !matches!(str_of(&job["conclusion"]), "failure" | "timed_out") {
            continue;
        }
        let job_id = job["id"].as_u64().unwrap_or(0);
        let refused = job["onProvider"] == json!(true)
            && job["failedStep"].as_str().is_some_and(is_runner_setup);
        let mut text = format!(
            "{}{}",
            str_of(&job["name"]),
            job["failedStep"]
                .as_str()
                .map(|s| format!(" failed at {}", s.split_once(". ").map_or(s, |(_, r)| r)))
                .unwrap_or_else(|| " failed".into())
        );
        if refused {
            text.push_str(&format!(
                "\n{name} stopped this job in its own setup, before any of your workflow's steps ran."
            ));
        }
        let path = format!("/{}/jobs/{job_id}/failure", encode(str_of(&report["id"])));
        if let Ok(Got::Ok(failure)) = call(credentials, "GET", &path, scope, None) {
            let log: Vec<String> = failure["log"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|l| l.as_str())
                .filter(|l| args.verbose || l.contains("##[error]"))
                .map(|l| l.to_string())
                .collect();
            if !log.is_empty() {
                text.push('\n');
                for line in log {
                    text.push_str(&format!(
                        "\n  {}",
                        line.replace("##[error]", &paint(Style::Red, "##[error]"))
                    ));
                }
            }
            if let Some(cause) = failure["cause"]["kind"].as_str().and_then(cause_text)
                && !refused
            {
                text.push_str(&format!("\n\nLikely cause: {cause}"));
            }
        }
        text.push_str(&format!(
            "\n\nJob on GitHub: https://github.com/{repo}/actions/runs/{run_id}/job/{job_id}"
        ));
        ui::message(&text);
    }
}

/// The AI's cause of a failure in words, as the dashboard has them.
fn cause_text(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "flaky" => "intermittent, so it would likely pass if run again",
        "lint" => "a lint, format or type check found problems in the code",
        "test" => "a test failed because of a change in the code",
        "build" => "compiling, bundling or installing dependencies failed",
        "infra" => "the runner or its environment broke",
        "config" => "the workflow or its setup is wrong",
        _ => return None,
    })
}

// ---- Small things --------------------------------------------------------------------------------

fn str_of(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}

fn file_of(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// A workflow's name, else its file: from a workflow (`path`) or an evaluation (`workflowPath`).
fn workflow_title(value: &Value) -> String {
    let path = value["path"]
        .as_str()
        .unwrap_or(str_of(&value["workflowPath"]));
    value["workflow"]
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| file_of(path).to_string())
}

/// A provider's name as the gateway lists it, else its id.
fn provider_name(credentials: &Credentials, scope: &mut Scope, id: &str) -> String {
    get(credentials, "/providers", scope)
        .ok()
        .and_then(|body| {
            body["providers"]
                .as_array()?
                .iter()
                .find(|p| str_of(&p["id"]) == id)
                .and_then(|p| p["name"].as_str().map(str::to_string))
        })
        .unwrap_or_else(|| id.to_string())
}

/// "$0.06".
pub fn money(usd: f64) -> String {
    if usd < 0.01 && usd > 0.0 {
        "<$0.01".into()
    } else {
        format!("${usd:.2}")
    }
}

/// "about 35 minutes", rounded for an estimate.
pub fn about(ms: u64) -> String {
    let mins = (ms as f64 / 60_000.0).round() as u64;
    match mins {
        0 | 1 => "a minute".into(),
        2..90 => format!("{mins} minutes"),
        _ => format!("{:.1} hours", ms as f64 / 3_600_000.0),
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Result<Args, Error> {
        Args::parse(&list.iter().map(|s| s.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn parses_a_start() {
        let parsed = args(&[
            "depot",
            "--workflow",
            "ci.yml",
            "--vcpus=8",
            "--yes",
            "--json",
        ])
        .unwrap();
        assert_eq!(parsed.action, Action::Start);
        assert_eq!(parsed.target.as_deref(), Some("depot"));
        assert_eq!(parsed.workflow.as_deref(), Some("ci.yml"));
        assert_eq!(parsed.vcpus, Some(8));
        assert!(parsed.yes && parsed.json && !parsed.detach);
    }

    #[test]
    fn parses_watch_list_and_stop() {
        assert_eq!(args(&["watch"]).unwrap().action, Action::Watch);
        assert_eq!(
            args(&["watch", "abc"]).unwrap().target.as_deref(),
            Some("abc")
        );
        assert_eq!(
            args(&["list", "--provider", "boat"])
                .unwrap()
                .provider
                .as_deref(),
            Some("boat")
        );
        assert_eq!(args(&["stop", "abc"]).unwrap().action, Action::Stop);
        assert!(args(&["stop"]).is_err());
    }

    #[test]
    fn refuses_bad_flags() {
        assert!(args(&["depot", "--vcpus", "zero"]).is_err());
        assert!(args(&["depot", "--repo", "just-a-name"]).is_err());
        assert!(args(&["depot", "--nope"]).is_err());
        assert!(args(&["depot", "boat"]).is_err());
    }

    #[test]
    fn reads_repos_from_remotes() {
        assert_eq!(
            repo_from_remote("git@github.com:acme/web.git").as_deref(),
            Some("acme/web")
        );
        assert_eq!(
            repo_from_remote("https://github.com/acme/web\n").as_deref(),
            Some("acme/web")
        );
        assert_eq!(repo_from_remote("https://gitlab.com/acme/web.git"), None);
    }

    #[test]
    fn finds_a_workflow_by_path_file_or_name() {
        let w = json!({ "path": ".github/workflows/ci.yml", "workflow": "CI" });
        assert!(matches_workflow(&w, ".github/workflows/ci.yml"));
        assert!(matches_workflow(&w, "ci.yml"));
        assert!(matches_workflow(&w, "ci"));
        assert!(!matches_workflow(&w, "e2e.yml"));
    }

    #[test]
    fn links_to_the_evaluation_in_its_workspace() {
        assert_eq!(
            dashboard_url("https://app.relayrunner.dev/", "depot", "9631d4b1", "acme"),
            "https://app.relayrunner.dev/providers/depot/evaluate?id=9631d4b1&workspace=acme"
        );
    }

    #[test]
    fn says_how_much_faster_and_cheaper() {
        assert_eq!(
            change(Some(400.0), Some(236.0), "faster", "slower"),
            "41% faster"
        );
        assert_eq!(
            change(Some(0.11), Some(0.13), "cheaper", "more"),
            "18% more"
        );
        assert_eq!(change(None, Some(1.0), "faster", "slower"), "");
        assert_eq!(money(0.054), "$0.05");
        assert_eq!(about(35 * 60_000), "35 minutes");
    }

    #[test]
    fn lists_the_checkouts_workflows_with_the_ones_that_ran() {
        use crate::init::LocalWorkflow;
        let local = |path: &str, routed| LocalWorkflow {
            path: path.into(),
            name: Some(format!("{path} name")),
            routed,
        };
        let mut workflows = vec![json!({
            "repositoryId": 5, "repository": "acme/web", "workflow": "CI",
            "path": ".github/workflows/ci.yml", "runs": 12, "relayed": false,
        })];
        add_local(
            &mut workflows,
            "Acme/Web",
            &[
                local(".github/workflows/ci.yml", true),
                local(".github/workflows/e2e.yml", false),
            ],
        );
        assert_eq!(workflows.len(), 2);
        // The file says it's routed now, ahead of its runs; its stats stay.
        assert_eq!(workflows[0]["relayed"], json!(true));
        assert_eq!(workflows[0]["runs"], json!(12));
        assert_eq!(workflows[1]["repositoryId"], json!(5));
        assert_eq!(workflows[1]["relayed"], json!(false));
        assert_eq!(workflows[1]["runs"], json!(0));
        assert_eq!(
            workflow_title(&workflows[1]),
            ".github/workflows/e2e.yml name"
        );

        // A new account: no runs at all, so no repository id until the gateway names it.
        let mut fresh = Vec::new();
        add_local(
            &mut fresh,
            "acme/web",
            &[local(".github/workflows/ci.yml", false)],
        );
        assert!(fresh[0]["repositoryId"].is_null());
        assert_eq!(
            workflow_choice(&fresh[0]).hint.as_deref(),
            Some("ci.yml · not routed through a relay yet")
        );
    }

    #[test]
    fn tells_the_provider_refused_before_any_step() {
        assert!(is_runner_setup("2. Set up runner"));
        assert!(!is_runner_setup("3. Run tests"));
    }
    #[test]
    fn live_view_shows_the_run_going_now() {
        let attempt = |n: u64, status: &str| json!({ "attempt": n, "status": status, "jobs": [] });
        let report = json!({
            "runs": 5,
            "state": "running",
            "attempts": [
                attempt(1, "done"),
                attempt(2, "running"),
                attempt(3, "waiting"),
                attempt(4, "waiting"),
                attempt(5, "waiting"),
            ],
        });
        let first = live_lines(&report, None).join("\n");
        assert!(first.contains("Run 2 of 5"), "{first}");
    }
}
