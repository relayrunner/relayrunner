//! `relayrunner init`: route a repo's GitHub Actions jobs through the relay, so they run on your
//! machine when it's online and on their old runner otherwise. It only edits files in the
//! checkout and never commits. Three ways to run it:
//!
//!   relayrunner init                   pick jobs, see the diff, confirm
//!   relayrunner init --plan [--json]   list every job with its verdict; changes nothing
//!   relayrunner init --apply <jobs>    route those jobs without prompting (`all` = every ready job)
//!
//! `--plan --json` and `--apply` are what an agent setting up RelayRunner drives.

mod diff;
mod repo;
mod workflows;

use crate::ui;
use repo::Visibility;
use serde_json::json;
use std::path::{Path, PathBuf};
use workflows::{FileError, RELAY_REF, Verdict, WorkflowFile, WorkflowJob};

pub struct Plan {
    root: PathBuf,
    repo: Option<String>,
    visibility: Visibility,
    files: Vec<WorkflowFile>,
    jobs: Vec<WorkflowJob>,
    errors: Vec<FileError>,
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
fn plan(cwd: &Path, vm: bool) -> Result<Plan, String> {
    let mut plan = local_plan(cwd, vm)?;
    plan.check_visibility();
    Ok(plan)
}

/// Everything but whether the repo is public, which takes asking GitHub.
fn local_plan(cwd: &Path, vm: bool) -> Result<Plan, String> {
    let root = repo::find_root(cwd).ok_or(NOT_A_CHECKOUT)?;
    let repo = repo::origin_repo(&root);
    let visibility = Visibility::Unknown;
    let files = repo::read_workflow_files(&root);
    let (jobs, errors) = workflows::analyze(
        &files,
        &workflows::Options {
            host_os: host_os(),
            vm,
        },
    );
    Ok(Plan {
        root,
        repo,
        visibility,
        files,
        jobs,
        errors,
    })
}

impl Plan {
    fn check_visibility(&mut self) {
        if let Some(repo) = &self.repo {
            self.visibility = repo::visibility(repo);
        }
    }
}

fn short_file(file: &str) -> &str {
    file.strip_prefix(".github/workflows/").unwrap_or(file)
}

/// Picks jobs by `job`, `file:job` or `all`. Fails when a name is unknown, ambiguous or not ready.
fn select_jobs(jobs: &[WorkflowJob], names: &[&str]) -> Result<Vec<WorkflowJob>, String> {
    let ready = || jobs.iter().filter(|j| j.verdict == Verdict::Ready).cloned();
    if names == ["all"] {
        return Ok(ready().collect());
    }
    let mut picked: Vec<WorkflowJob> = Vec::new();
    for &name in names {
        let (file, id) = match name.rsplit_once(':') {
            Some((file, id)) => (Some(file), id),
            None => (None, name),
        };
        let matches: Vec<&WorkflowJob> = jobs
            .iter()
            .filter(|j| j.job == id && file.is_none_or(|f| j.file == f || short_file(&j.file) == f))
            .collect();
        let job = match matches.as_slice() {
            [] => return Err(format!("No job named {name}.")),
            [job] => *job,
            _ => {
                let names: Vec<String> = matches
                    .iter()
                    .map(|j| format!("{}:{}", j.file, j.job))
                    .collect();
                return Err(format!(
                    "{name} is in more than one workflow. Name it as {}.",
                    names.join(" or ")
                ));
            }
        };
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
        change.after = workflows::route_jobs(&change.before, &change.jobs).map_err(|reason| {
            format!(
                "Couldn't edit {}: {reason}. Route its jobs by hand: https://relayrunner.app/docs/get-started/github-actions",
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

fn job_line(job: &WorkflowJob) -> String {
    let name = format!("{} › {}", short_file(&job.file), job.job);
    match job.verdict {
        Verdict::Skipped => format!("{name}: {}", job.reason.as_deref().unwrap_or_default()),
        Verdict::Routed => name,
        Verdict::Ready => {
            let mut notes = vec![format!(
                "falls back to {}",
                job.label.as_deref().unwrap_or_default()
            )];
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
            relay: RELAY_REF,
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
            println!("  {}", job_line(job));
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
    let names: Vec<&str> = list
        .split(',')
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .collect();
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
                warnings: &j.warnings,
            })
            .collect();
        let out = Out {
            relay: RELAY_REF,
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
    Ok(())
}

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
            .map(|j| job_line(j))
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
            let mut hint = vec![format!(
                "{} when your machine is offline",
                j.label.as_deref().unwrap_or_default()
            )];
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
    let files: Vec<&str> = changes.iter().map(|c| c.file.as_str()).collect();
    finish(&format!(
        "Updated {}. Commit and push to start routing.",
        files.join(", ")
    ));
    Ok(())
}

pub async fn command(args: &[String]) -> i32 {
    let (mut plan_only, mut json, mut apply_list) = (false, false, None::<String>);
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--plan" => plan_only = true,
            "--json" => json = true,
            "--apply" => apply_list = Some(rest.next().cloned().unwrap_or_default()),
            other => match other.strip_prefix("--apply=") {
                Some(list) => apply_list = Some(list.to_string()),
                None => {
                    eprintln!("Unknown option {other:?}. Run `relayrunner init --help`.");
                    return 2;
                }
            },
        }
    }
    // Whether jobs here would run in VMs only matters inside a checkout.
    let in_checkout = std::env::current_dir()
        .ok()
        .and_then(|cwd| repo::find_root(&cwd))
        .is_some();
    let vm = in_checkout && crate::isolated::state().await == crate::isolated::State::Ready;
    let run = move || -> Result<(), String> {
        let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
        let plan = plan(&cwd, vm)?;
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
    let Ok(mut plan) = local_plan(&cwd, vm) else {
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
        let plan = plan(&root, false).unwrap();
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
        let first = plan(&root.join("src"), false).unwrap();
        assert_eq!(first.root, root);
        assert_eq!(first.repo, None);
        let changes = changes_for(&first, &select_jobs(&first.jobs, &["lint"]).unwrap()).unwrap();
        write_changes(&root, &changes).unwrap();
        let written = std::fs::read_to_string(root.join(".github/workflows/ci.yml")).unwrap();
        assert!(written.contains("relay-lint:"));
        assert!(!written.contains("relay-test:"));
        let again = plan(&root, false).unwrap();
        assert_eq!(verdicts(&again), ["test:Ready", "lint:Routed"]);
        assert!(!should_offer_setup(&again));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn offers_setup_only_when_it_helps() {
        let root = checkout(&[("ci.yml", CI)]);
        let mut open = plan(&root, false).unwrap();
        assert!(should_offer_setup(&open));
        open.visibility = Visibility::Public;
        assert!(!should_offer_setup(&open));
        let deploy = checkout(&[("deploy.yml", DEPLOY)]);
        assert!(!should_offer_setup(&plan(&deploy, false).unwrap()));
        assert!(
            plan(&std::env::temp_dir(), false)
                .err()
                .is_some_and(|e| e == NOT_A_CHECKOUT)
                || repo::find_root(&std::env::temp_dir()).is_some()
        );
        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&deploy).unwrap();
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
