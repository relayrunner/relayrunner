//! `relayrunner init`: route a repo's GitHub Actions jobs through the relay, so they run on your
//! machine when it's online and on their old runner otherwise. It only edits files in the
//! checkout and never commits. Three ways to run it:
//!
//!   relayrunner init                   pick jobs, see the diff, confirm
//!   relayrunner init --plan [--json]   list every job with its verdict; changes nothing
//!   relayrunner init --apply <jobs>    route those jobs without prompting (`all` = every ready job)
//!
//! Each relay gets the job's shape (`os`, plus `arch` and `cpus` when its label asks for them), so
//! any provider on the Router can take it. `--exact` writes the old label under its provider instead.
//! `--allow-deploy <jobs>` lets jobs that look like deploy jobs be routed, once the user says so.
//!
//! `--plan --json` and `--apply` are what an agent setting up RelayRunner drives.

mod diff;
mod repo;
mod workflows;

use crate::ui;
use repo::Visibility;
use serde_json::json;
use std::path::{Path, PathBuf};
use workflows::{FileError, Verdict, WorkflowFile, WorkflowJob, short_file};

pub struct Plan {
    root: PathBuf,
    repo: Option<String>,
    visibility: Visibility,
    files: Vec<WorkflowFile>,
    jobs: Vec<WorkflowJob>,
    errors: Vec<FileError>,
    /// Write each job's old label instead of its shape (`--exact`).
    exact: bool,
}

const PUBLIC_REPO: &str = "This repo is public, and machines never take jobs from public repos. There's nothing for init to set up here.";
const NOT_A_CHECKOUT: &str = "Not in a git checkout. Run `relayrunner init` inside a repo.";

fn host_os() -> Option<&'static str> {
    if cfg!(target_os = "macos") {
        Some("macos")
    } else if cfg!(target_os = "linux") {
        Some("linux")
    } else {
        None
    }
}

/// `vm`: this machine runs Linux jobs in VMs, which have Docker and Linux packages.
/// `allow_deploy`: jobs to treat as ready even though they look like deploy jobs. Each must name
/// exactly one job.
fn plan(cwd: &Path, vm: bool, allow_deploy: &[String]) -> Result<Plan, String> {
    let mut plan = local_plan(cwd, vm, allow_deploy)?;
    for name in allow_deploy {
        find_job(&plan.jobs, name)?;
    }
    plan.check_visibility();
    Ok(plan)
}

/// Everything but whether the repo is public, which takes asking GitHub.
fn local_plan(cwd: &Path, vm: bool, allow_deploy: &[String]) -> Result<Plan, String> {
    let root = repo::find_root(cwd).ok_or(NOT_A_CHECKOUT)?;
    let repo = repo::origin_repo(&root);
    let visibility = Visibility::Unknown;
    let files = repo::read_workflow_files(&root);
    let (jobs, errors) = workflows::analyze(
        &files,
        &workflows::Options {
            host_os: host_os(),
            vm,
            allow_deploy: allow_deploy.to_vec(),
        },
    );
    Ok(Plan {
        root,
        repo,
        visibility,
        files,
        jobs,
        errors,
        exact: false,
    })
}

impl Plan {
    fn check_visibility(&mut self) {
        if let Some(repo) = &self.repo {
            self.visibility = repo::visibility(repo);
        }
    }
}

/// The one job `name` (`job` or `file:job`) names. Fails when it's unknown or ambiguous.
fn find_job<'a>(jobs: &'a [WorkflowJob], name: &str) -> Result<&'a WorkflowJob, String> {
    let matches: Vec<&WorkflowJob> = jobs
        .iter()
        .filter(|j| workflows::names_job(name, &j.file, &j.job))
        .collect();
    match matches.as_slice() {
        [] => Err(format!("No job named {name}.")),
        [job] => Ok(job),
        _ => {
            let names: Vec<String> = matches
                .iter()
                .map(|j| format!("{}:{}", j.file, j.job))
                .collect();
            Err(format!(
                "{name} is in more than one workflow. Name it as {}.",
                names.join(" or ")
            ))
        }
    }
}

/// Picks jobs by `job`, `file:job` or `all`. Fails when a name is unknown, ambiguous or not ready.
fn select_jobs(
    jobs: &[WorkflowJob],
    names: &[impl AsRef<str>],
) -> Result<Vec<WorkflowJob>, String> {
    if let [all] = names
        && all.as_ref() == "all"
    {
        return Ok(jobs
            .iter()
            .filter(|j| j.verdict == Verdict::Ready)
            .cloned()
            .collect());
    }
    let mut picked: Vec<WorkflowJob> = Vec::new();
    for name in names {
        let name = name.as_ref();
        let job = find_job(jobs, name)?;
        match job.verdict {
            Verdict::Routed => return Err(format!("{name} is already routed.")),
            Verdict::Skipped => {
                return Err(format!(
                    "{name} can't be routed: {}.",
                    job.reason.as_deref().unwrap_or_default()
                ));
            }
            Verdict::Ready => {}
        }
        if !picked
            .iter()
            .any(|p| p.file == job.file && p.job == job.job)
        {
            picked.push(job.clone());
        }
    }
    Ok(picked)
}

struct Change {
    file: String,
    jobs: Vec<WorkflowJob>,
    before: String,
    after: String,
}

/// The new contents of each workflow file the chosen jobs live in.
fn changes_for(plan: &Plan, chosen: &[WorkflowJob]) -> Result<Vec<Change>, String> {
    let mut changes: Vec<Change> = Vec::new();
    for job in chosen {
        match changes.iter_mut().find(|c| c.file == job.file) {
            Some(change) => change.jobs.push(job.clone()),
            None => changes.push(Change {
                file: job.file.clone(),
                jobs: vec![job.clone()],
                before: plan
                    .files
                    .iter()
                    .find(|f| f.file == job.file)
                    .map(|f| f.source.clone())
                    .unwrap_or_default(),
                after: String::new(),
            }),
        }
    }
    for change in &mut changes {
        change.after = workflows::route_jobs(&change.before, &change.jobs, plan.exact).map_err(|reason| {
            format!(
                "Couldn't edit {}: {reason}. Route its jobs by hand: https://relayrunner.dev/docs/get-started/github-actions",
                change.file
            )
        })?;
    }
    Ok(changes)
}

fn write_changes(root: &Path, changes: &[Change]) -> Result<(), String> {
    for change in changes {
        std::fs::write(root.join(&change.file), &change.after)
            .map_err(|e| format!("Couldn't write {}: {e}.", change.file))?;
    }
    Ok(())
}

fn describe_repo(plan: &Plan) -> String {
    match &plan.repo {
        None => format!("{} (no GitHub remote named origin)", plan.root.display()),
        Some(repo) if plan.visibility == Visibility::Unknown => repo.clone(),
        Some(repo) => format!("{repo} ({})", plan.visibility.as_str()),
    }
}

/// Where a ready job will run once routed, for the plan and the picker.
fn runs_where(job: &WorkflowJob, exact: bool) -> String {
    let label = job.label.as_deref().unwrap_or_default();
    match (&job.shape, exact) {
        (Some(shape), false) => {
            format!("any Router runner with {} (was {label})", shape.describe())
        }
        _ => format!("falls back to {label}"),
    }
}

fn job_line(job: &WorkflowJob, exact: bool) -> String {
    let name = format!("{} › {}", short_file(&job.file), job.job);
    match job.verdict {
        Verdict::Skipped => format!("{name}: {}", job.reason.as_deref().unwrap_or_default()),
        Verdict::Routed => name,
        Verdict::Ready => {
            let mut notes = vec![runs_where(job, exact)];
            notes.extend(job.warnings.iter().cloned());
            format!("{name}: {}", notes.join("; "))
        }
    }
}

fn print_plan(plan: &Plan, json: bool) {
    if json {
        // A struct rather than json!, which would sort the keys.
        #[derive(serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Out<'a> {
            repo: &'a Option<String>,
            visibility: &'static str,
            relay: &'static str,
            set_up: bool,
            #[serde(skip_serializing_if = "Option::is_none")]
            refused: Option<&'static str>,
            jobs: &'a [WorkflowJob],
            errors: &'a [FileError],
        }
        let out = Out {
            repo: &plan.repo,
            visibility: plan.visibility.as_str(),
            relay: workflows::relay_ref(),
            set_up: workflows::is_set_up(&plan.jobs),
            refused: (plan.visibility == Visibility::Public).then_some("public_repo"),
            jobs: &plan.jobs,
            errors: &plan.errors,
        };
        println!("{}", serde_json::to_string_pretty(&out).unwrap_or_default());
        return;
    }
    println!("{}", describe_repo(plan));
    if plan.visibility == Visibility::Public {
        println!("{PUBLIC_REPO}");
        return;
    }
    if plan.files.is_empty() {
        println!("No workflows in .github/workflows.");
        return;
    }
    for (title, verdict) in [
        ("Ready to route", Verdict::Ready),
        ("Already routed", Verdict::Routed),
        ("Skipped", Verdict::Skipped),
    ] {
        let jobs: Vec<&WorkflowJob> = plan.jobs.iter().filter(|j| j.verdict == verdict).collect();
        if jobs.is_empty() {
            continue;
        }
        println!("\n{title}");
        for job in jobs {
            println!("  {}", job_line(job, plan.exact));
        }
    }
    for error in &plan.errors {
        println!("\nCouldn't read {}: {}", error.file, error.message);
    }
}

fn apply(plan: &Plan, list: &str, json: bool) -> Result<(), String> {
    if plan.visibility == Visibility::Public {
        return Err(PUBLIC_REPO.into());
    }
    let names = job_names(list);
    if names.is_empty() {
        return Err("Name the jobs to route, or `all`.".into());
    }
    let chosen = select_jobs(&plan.jobs, &names)?;
    if chosen.is_empty() {
        return Err("No jobs are ready to route.".into());
    }
    let changes = changes_for(plan, &chosen)?;
    write_changes(&plan.root, &changes)?;
    if json {
        #[derive(serde::Serialize)]
        struct Routed<'a> {
            file: &'a str,
            job: &'a str,
            /// The relay's inputs, such as `{"os": "linux", "cpus": "4"}`.
            with: serde_json::Map<String, serde_json::Value>,
            warnings: &'a [String],
        }
        #[derive(serde::Serialize)]
        struct Out<'a> {
            relay: &'static str,
            routed: Vec<Routed<'a>>,
        }
        let routed = chosen
            .iter()
            .map(|j| Routed {
                file: &j.file,
                job: &j.job,
                with: workflows::relay_inputs(j, plan.exact)
                    .unwrap_or_default()
                    .into_iter()
                    .map(|(k, v)| (k, serde_json::Value::String(v)))
                    .collect(),
                warnings: &j.warnings,
            })
            .collect();
        let out = Out {
            relay: workflows::relay_ref(),
            routed,
        };
        println!("{}", serde_json::to_string_pretty(&out).unwrap_or_default());
        return Ok(());
    }
    for change in &changes {
        let ids: Vec<&str> = change.jobs.iter().map(|j| j.job.as_str()).collect();
        println!("Updated {} ({})", change.file, ids.join(", "));
    }
    println!("Commit and push to start routing.");
    println!("{SKILLS_TIP}");
    Ok(())
}

/// Shown after `init` routes jobs (never in `--json`), so people find the agent skills in skills/.
const SKILLS_TIP: &str =
    "Using a coding agent? Give it the RelayRunner skills: npx skills add relayrunner/relayrunner";

fn interactive(plan: &Plan) -> Result<(), String> {
    ui::intro("RelayRunner init");
    ui::info(&describe_repo(plan));
    if plan.visibility == Visibility::Public {
        ui::outro(PUBLIC_REPO);
        return Ok(());
    }
    if plan.visibility == Visibility::Unknown {
        ui::warn(
            "Couldn't check whether this repo is public. Machines only take jobs from private repos.",
        );
    }
    for error in &plan.errors {
        ui::warn(&format!("Couldn't read {}: {}", error.file, error.message));
    }
    if plan.files.is_empty() {
        ui::outro("No workflows in .github/workflows.");
        return Ok(());
    }
    choose_and_write(plan, ui::outro)
}

/// Lists the jobs, lets the user pick, shows the diff and writes it. `finish` shows the last line.
fn choose_and_write(plan: &Plan, finish: fn(&str)) -> Result<(), String> {
    let with = |verdict| -> Vec<&WorkflowJob> {
        plan.jobs.iter().filter(|j| j.verdict == verdict).collect()
    };
    let lines = |jobs: &[&WorkflowJob]| -> String {
        jobs.iter()
            .map(|j| job_line(j, plan.exact))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let (routed, skipped, ready) = (
        with(Verdict::Routed),
        with(Verdict::Skipped),
        with(Verdict::Ready),
    );
    if !routed.is_empty() {
        ui::note(&lines(&routed), "Already routed");
    }
    if !skipped.is_empty() {
        ui::note(&lines(&skipped), "Skipped");
    }
    if ready.is_empty() {
        finish("No other jobs to route.");
        return Ok(());
    }

    let choices: Vec<ui::Choice> = ready
        .iter()
        .map(|j| {
            let mut hint = vec![runs_where(j, plan.exact)];
            hint.extend(j.warnings.iter().cloned());
            ui::Choice {
                label: format!("{} › {}", short_file(&j.file), j.job),
                hint: Some(hint.join("; ")),
            }
        })
        .collect();
    let picked: Vec<WorkflowJob> =
        match ui::multiselect("Route these jobs through RelayRunner?", &choices) {
            Some(picks) if !picks.is_empty() => {
                picks.into_iter().map(|i| ready[i].clone()).collect()
            }
            _ => {
                finish("Nothing changed.");
                return Ok(());
            }
        };

    let changes = changes_for(plan, &picked)?;
    for change in &changes {
        println!(
            "{}\n",
            ui::colored_diff(&diff::unified(&change.before, &change.after, &change.file))
        );
    }
    let question = if changes.len() == 1 {
        "Write this change?".to_string()
    } else {
        format!("Write these {} changes?", changes.len())
    };
    if ui::confirm(&question, true) != Some(true) {
        finish("Nothing changed.");
        return Ok(());
    }

    write_changes(&plan.root, &changes)?;
    let warned: Vec<String> = picked
        .iter()
        .filter(|j| !j.warnings.is_empty())
        .map(|j| format!("{}: {}", j.job, j.warnings.join("; ")))
        .collect();
    if !warned.is_empty() {
        ui::note(&warned.join("\n"), "Check before it runs on your machine");
    }
    ui::info(SKILLS_TIP);
    let files: Vec<&str> = changes.iter().map(|c| c.file.as_str()).collect();
    finish(&format!(
        "Updated {}. Commit and push to start routing.",
        files.join(", ")
    ));
    Ok(())
}

pub async fn command(args: &[String]) -> i32 {
    let (mut plan_only, mut json, mut exact, mut apply_list) =
        (false, false, false, None::<String>);
    let mut allow_deploy: Vec<String> = Vec::new();
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--plan" => plan_only = true,
            "--json" => json = true,
            "--exact" => exact = true,
            // Older agents' flag, from when the default wrote labels. Shapes size jobs now.
            "--auto" => {}
            "--apply" => apply_list = Some(rest.next().cloned().unwrap_or_default()),
            "--allow-deploy" => {
                allow_deploy.extend(job_names(rest.next().map_or("", String::as_str)));
            }
            other => {
                if let Some(list) = other.strip_prefix("--apply=") {
                    apply_list = Some(list.to_string());
                } else if let Some(list) = other.strip_prefix("--allow-deploy=") {
                    allow_deploy.extend(job_names(list));
                } else {
                    eprintln!("Unknown option {other:?}. Run `relayrunner init --help`.");
                    return 2;
                }
            }
        }
    }
    // Whether jobs here would run in VMs only matters inside a checkout.
    let vm = in_checkout() && crate::isolated::state().await == crate::isolated::State::Ready;
    let run = move || -> Result<(), String> {
        let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
        let plan = Plan {
            exact,
            ..plan(&cwd, vm, &allow_deploy)?
        };
        if let Some(list) = apply_list {
            return apply(&plan, &list, json);
        }
        if plan_only || json {
            print_plan(&plan, json);
            return Ok(());
        }
        if !ui::can_ask() {
            print_plan(&plan, false);
            println!("\nRun `relayrunner init --apply <jobs>` to route jobs without prompts.");
            return Ok(());
        }
        interactive(&plan)
    };
    match tokio::task::spawn_blocking(run).await {
        Ok(Ok(())) => 0,
        Ok(Err(message)) => {
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&json!({ "error": message })).unwrap_or_default()
                );
            } else {
                eprintln!("{message}");
            }
            1
        }
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

/// Whether the working directory is inside a git checkout.
pub fn in_checkout() -> bool {
    std::env::current_dir()
        .ok()
        .and_then(|cwd| repo::find_root(&cwd))
        .is_some()
}

/// A comma-separated list of job names.
fn job_names(list: &str) -> Vec<String> {
    list.split(',')
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string)
        .collect()
}

/// Whether `connect` should offer to set up this checkout: it's not public, nothing in it is
/// routed yet, and at least one job could be.
fn should_offer_setup(plan: &Plan) -> bool {
    plan.visibility != Visibility::Public
        && !workflows::is_set_up(&plan.jobs)
        && plan.jobs.iter().any(|j| j.verdict == Verdict::Ready)
}

/// Repos where the user said no to `connect`'s offer, kept in <home>/declined-repos.json as a list
/// of `owner/name` (or the checkout's path when it has no GitHub remote). `init` ignores it.
fn declined_path() -> PathBuf {
    crate::credentials::home().join("declined-repos.json")
}

fn declined(path: &Path) -> Vec<String> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|value| {
            value.as_array().map(|list| {
                list.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
        })
        .unwrap_or_default()
}

fn remember_declined(path: &Path, repo: &str) {
    let mut repos = declined(path);
    if repos.iter().any(|r| r == repo) {
        return;
    }
    repos.push(repo.to_string());
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(
        path,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&repos).unwrap_or_default()
        ),
    );
}

/// Run by `connect` before it goes online, when someone's at the terminal. Inside a repo that
/// could use RelayRunner but doesn't yet, asks once whether to set it up (default no) and runs the
/// same picker as `init`. A "no" is remembered for that repo; `relayrunner init` still works.
/// Never fails: `connect` goes online either way.
pub fn offer_setup(vm: bool) {
    let Ok(cwd) = std::env::current_dir() else {
        return;
    };
    // Outside a checkout there's nothing to offer. GitHub is only asked once the local checks
    // say there would be an offer, since `connect` waits on this before going online.
    let Ok(mut plan) = local_plan(&cwd, vm, &[]) else {
        return;
    };
    if !should_offer_setup(&plan) {
        return;
    }
    let key = plan
        .repo
        .clone()
        .unwrap_or_else(|| plan.root.display().to_string());
    let path = declined_path();
    if declined(&path).contains(&key) {
        return;
    }
    plan.check_visibility();
    if !should_offer_setup(&plan) {
        return;
    }
    let name = plan.repo.clone().unwrap_or_else(|| {
        plan.root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    });
    match ui::confirm(
        &format!("Set up {name} to run its CI on this machine?"),
        false,
    ) {
        None => {}
        Some(false) => {
            remember_declined(&path, &key);
            ui::info("Not now. Run `relayrunner init` in this repo any time to set it up.");
        }
        Some(true) => {
            if let Err(message) = choose_and_write(&plan, ui::success) {
                ui::warn(&message);
            }
        }
    }
}

/// A workflow file in the checkout, as `eval` lists it.
pub struct LocalWorkflow {
    /// Such as `.github/workflows/ci.yml`.
    pub path: String,
    pub name: Option<String>,
    /// Whether any of its jobs already goes through a relay.
    pub routed: bool,
}

/// The checkout `eval` runs in, when it's a clone of the repo being evaluated.
pub struct Checkout {
    pub root: PathBuf,
    pub workflows: Vec<LocalWorkflow>,
    plan: Plan,
}

/// This checkout, when `origin` is `repo`. Reads only local files.
pub fn checkout_of(repo: &str, vm: bool) -> Option<Checkout> {
    let cwd = std::env::current_dir().ok()?;
    let plan = local_plan(&cwd, vm, &[]).ok()?;
    if !plan
        .repo
        .as_deref()
        .is_some_and(|r| r.eq_ignore_ascii_case(repo))
    {
        return None;
    }
    let workflows = plan
        .files
        .iter()
        .map(|f| LocalWorkflow {
            path: f.file.clone(),
            name: workflows::workflow_name(&f.source),
            routed: plan
                .jobs
                .iter()
                .any(|j| j.file == f.file && j.verdict == Verdict::Routed),
        })
        .collect();
    Some(Checkout {
        root: plan.root.clone(),
        workflows,
        plan,
    })
}

/// The change `route_for_eval` wrote.
pub struct Edit {
    pub before: String,
    pub after: String,
    /// Whether the workflow could already be started on demand, before the edit.
    pub dispatchable: bool,
}

/// Run by `eval` for a workflow whose jobs don't go through a relay yet: init's picker for that
/// one file. The same edit adds workflow_dispatch to its triggers when it's missing, so the
/// evaluation can start it. Shows one diff and writes it after a yes. None when nothing changed.
pub fn route_for_eval(checkout: &Checkout, file: &str) -> Result<Option<Edit>, String> {
    let plan = &checkout.plan;
    let before = plan
        .files
        .iter()
        .find(|f| f.file == file)
        .map(|f| f.source.clone())
        .ok_or_else(|| format!("{file} isn't in this checkout."))?;
    let jobs: Vec<&WorkflowJob> = plan.jobs.iter().filter(|j| j.file == file).collect();
    let ready: Vec<&WorkflowJob> = jobs
        .iter()
        .copied()
        .filter(|j| j.verdict == Verdict::Ready)
        .collect();
    let skipped: Vec<String> = jobs
        .iter()
        .filter(|j| j.verdict == Verdict::Skipped)
        .map(|j| job_line(j, plan.exact))
        .collect();
    if ready.is_empty() {
        let mut message = format!(
            "None of {}'s jobs can go through a relay.",
            short_file(file)
        );
        if !skipped.is_empty() {
            message.push('\n');
            message.push_str(&skipped.join("\n"));
        }
        return Err(message);
    }
    if !skipped.is_empty() {
        ui::note(&skipped.join("\n"), "Skipped");
    }
    let choices: Vec<ui::Choice> = ready
        .iter()
        .map(|j| {
            let mut hint = vec![runs_where(j, plan.exact)];
            hint.extend(j.warnings.iter().cloned());
            ui::Choice {
                label: format!("{} › {}", short_file(&j.file), j.job),
                hint: Some(hint.join("; ")),
            }
        })
        .collect();
    let picked: Vec<WorkflowJob> =
        match ui::multiselect("Route these jobs through RelayRunner?", &choices) {
            Some(picks) if !picks.is_empty() => {
                picks.into_iter().map(|i| ready[i].clone()).collect()
            }
            _ => return Ok(None),
        };
    let routed = workflows::route_jobs(&before, &picked, plan.exact).map_err(|reason| {
        format!(
            "Couldn't edit {file}: {reason}. Route its jobs by hand: https://relayrunner.dev/docs/get-started/github-actions"
        )
    })?;
    // A trigger it can't add is left to the evaluation, which shows the line to add.
    let dispatchable = workflows::has_dispatch(&before);
    let after = if dispatchable {
        routed
    } else {
        workflows::add_dispatch(&routed).unwrap_or(routed)
    };
    println!(
        "{}\n",
        ui::colored_diff(&diff::unified(&before, &after, file))
    );
    if ui::confirm("Write this change?", true) != Some(true) {
        return Ok(None);
    }
    std::fs::write(checkout.root.join(file), &after)
        .map_err(|e| format!("Couldn't write {file}: {e}."))?;
    let warned: Vec<String> = picked
        .iter()
        .filter(|j| !j.warnings.is_empty())
        .map(|j| format!("{}: {}", j.job, j.warnings.join("; ")))
        .collect();
    if !warned.is_empty() {
        ui::note(&warned.join("\n"), "Check before it runs on your machine");
    }
    Ok(Some(Edit {
        before,
        after,
        dispatchable,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const CI: &str = "on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n  lint:\n    runs-on: ubuntu-latest\n";
    const DEPLOY: &str =
        "on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    environment: prod\n";

    fn checkout(files: &[(&str, &str)]) -> PathBuf {
        let root = std::env::temp_dir().join(format!("rr-init-{}", fastrand::u64(..)));
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::create_dir_all(root.join(".github/workflows")).unwrap();
        for (name, source) in files {
            std::fs::write(root.join(".github/workflows").join(name), source).unwrap();
        }
        root
    }

    fn verdicts(plan: &Plan) -> Vec<String> {
        plan.jobs
            .iter()
            .map(|j| format!("{}:{:?}", j.job, j.verdict))
            .collect()
    }

    #[test]
    fn selects_by_id_by_file_and_all() {
        let root = checkout(&[("ci.yml", CI), ("deploy.yml", DEPLOY)]);
        let plan = plan(&root, false, &[]).unwrap();
        let ids = |names: &[&str]| -> Result<Vec<String>, String> {
            Ok(select_jobs(&plan.jobs, names)?
                .into_iter()
                .map(|j| format!("{}:{}", short_file(&j.file), j.job))
                .collect())
        };
        assert_eq!(ids(&["lint"]).unwrap(), ["ci.yml:lint"]);
        assert_eq!(ids(&["ci.yml:test"]).unwrap(), ["ci.yml:test"]);
        assert_eq!(ids(&["all"]).unwrap().len(), 2);
        assert!(
            ids(&["test"])
                .unwrap_err()
                .contains("more than one workflow")
        );
        assert!(
            ids(&["deploy.yml:test"])
                .unwrap_err()
                .contains("deploy job")
        );
        assert!(ids(&["nope"]).unwrap_err().contains("No job named nope"));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn writes_the_chosen_jobs_and_nothing_else() {
        let root = checkout(&[("ci.yml", CI)]);
        std::fs::create_dir_all(root.join("src")).unwrap();
        let first = plan(&root.join("src"), false, &[]).unwrap();
        assert_eq!(first.root, root);
        assert_eq!(first.repo, None);
        let changes = changes_for(&first, &select_jobs(&first.jobs, &["lint"]).unwrap()).unwrap();
        write_changes(&root, &changes).unwrap();
        let written = std::fs::read_to_string(root.join(".github/workflows/ci.yml")).unwrap();
        assert!(written.contains("relay-lint:"));
        assert!(!written.contains("relay-test:"));
        let again = plan(&root, false, &[]).unwrap();
        assert_eq!(verdicts(&again), ["test:Ready", "lint:Routed"]);
        assert!(!should_offer_setup(&again));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn allow_deploy_names_one_job() {
        let root = checkout(&[("ci.yml", CI), ("deploy.yml", DEPLOY)]);
        let allowed = plan(&root, false, &job_names("deploy.yml:test")).unwrap();
        assert_eq!(
            select_jobs(&allowed.jobs, &["deploy.yml:test"]).unwrap()[0].job,
            "test"
        );
        assert!(
            plan(&root, false, &job_names("test"))
                .err()
                .unwrap()
                .contains("more than one workflow")
        );
        assert!(
            plan(&root, false, &job_names("nope"))
                .err()
                .unwrap()
                .contains("No job named nope")
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn offers_setup_only_when_it_helps() {
        let root = checkout(&[("ci.yml", CI)]);
        let mut open = plan(&root, false, &[]).unwrap();
        assert!(should_offer_setup(&open));
        open.visibility = Visibility::Public;
        assert!(!should_offer_setup(&open));
        let deploy = checkout(&[("deploy.yml", DEPLOY)]);
        assert!(!should_offer_setup(&plan(&deploy, false, &[]).unwrap()));
        assert!(
            plan(&std::env::temp_dir(), false, &[])
                .err()
                .is_some_and(|e| e == NOT_A_CHECKOUT)
                || repo::find_root(&std::env::temp_dir()).is_some()
        );
        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&deploy).unwrap();
    }

    #[test]
    fn routes_and_adds_workflow_dispatch_in_one_edit() {
        let root = checkout(&[("ci.yml", CI)]);
        let plan = plan(&root, false, &[]).unwrap();
        let routed =
            workflows::route_jobs(CI, &select_jobs(&plan.jobs, &["test"]).unwrap(), false).unwrap();
        let after = workflows::add_dispatch(&routed).unwrap();
        assert!(after.starts_with("on: [push, workflow_dispatch]\n"));
        assert!(workflows::has_dispatch(&after) && !workflows::has_dispatch(CI));
        let (jobs, errors) = workflows::analyze(
            &[WorkflowFile {
                file: ".github/workflows/ci.yml".into(),
                source: after,
            }],
            &workflows::Options::default(),
        );
        assert!(errors.is_empty());
        assert!(workflows::is_set_up(&jobs));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn remembers_a_no_per_repo() {
        let path = std::env::temp_dir()
            .join(format!("rr-home-{}", fastrand::u64(..)))
            .join("declined-repos.json");
        assert!(declined(&path).is_empty());
        remember_declined(&path, "acme/web");
        remember_declined(&path, "acme/web");
        assert_eq!(declined(&path), ["acme/web"]);
        std::fs::write(&path, "{not json").unwrap();
        assert!(declined(&path).is_empty());
        remember_declined(&path, "acme/web");
        assert_eq!(declined(&path), ["acme/web"]);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}
