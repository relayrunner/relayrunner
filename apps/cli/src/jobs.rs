//! `relayrunner jobs [id]`: the jobs this machine ran, as the gateway has them (GET
//! /api/machines/me/jobs). Unlike `history`, which reads this computer's own file, these come with
//! GitHub's steps and, for a failed job, why it failed. The Mac app's runner window reads them
//! with `--json`.

use crate::api::{self, Reply};
use crate::credentials::Credentials;
use crate::error::Error;
use crate::history::{ago, duration};
use crate::share;
use serde_json::{Value, json};
use std::time::{SystemTime, UNIX_EPOCH};

const USAGE: &str = "Usage: relayrunner jobs [--json] [--limit N] [--before MS] [--repo OWNER/NAME] \
[--workflow NAME] [--result succeeded|failed|canceled] [--since MS] | relayrunner jobs <id> [--json]";

const RESULTS: [&str; 3] = ["succeeded", "failed", "canceled"];

#[derive(Default)]
struct Args {
    json: bool,
    limit: Option<u32>,
    before: Option<u64>,
    repo: Option<String>,
    workflow: Option<String>,
    result: Option<String>,
    since: Option<u64>,
    id: Option<u64>,
}

fn parse(args: &[String]) -> Result<Args, Error> {
    let invalid = |message: String| Error::new("INVALID_ARGUMENT", message);
    let mut parsed = Args::default();
    let mut rest = args.iter();
    let ms = |value: Option<&String>, flag: &str| {
        value
            .and_then(|n| n.parse().ok())
            .filter(|n| *n > 0)
            .ok_or_else(|| invalid(format!("{flag} takes a time in ms.")))
    };
    let name = |value: Option<&String>, flag: &str| {
        value
            .filter(|value| !value.is_empty())
            .cloned()
            .ok_or_else(|| invalid(format!("{flag} takes a name.")))
    };
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--json" => parsed.json = true,
            "--limit" => {
                parsed.limit = Some(
                    rest.next()
                        .and_then(|n| n.parse().ok())
                        .filter(|n| (1..=100).contains(n))
                        .ok_or_else(|| invalid("--limit takes a number from 1 to 100.".into()))?,
                );
            }
            "--before" => parsed.before = Some(ms(rest.next(), arg)?),
            "--since" => parsed.since = Some(ms(rest.next(), arg)?),
            "--repo" => parsed.repo = Some(name(rest.next(), arg)?),
            "--workflow" => parsed.workflow = Some(name(rest.next(), arg)?),
            "--result" => {
                parsed.result = Some(
                    rest.next()
                        .filter(|value| RESULTS.contains(&value.as_str()))
                        .cloned()
                        .ok_or_else(|| {
                            invalid("--result takes succeeded, failed or canceled.".into())
                        })?,
                );
            }
            other if parsed.id.is_none() && !other.starts_with('-') => {
                parsed.id = Some(
                    other
                        .parse()
                        .ok()
                        .filter(|n| *n > 0)
                        .ok_or_else(|| invalid(format!("{other:?} isn't a job id. {USAGE}")))?,
                );
            }
            other => return Err(invalid(format!("Unknown option {other:?}. {USAGE}"))),
        }
    }
    Ok(parsed)
}

enum Got {
    Ok(Value),
    NotFound,
}

fn get(credentials: &Credentials, path: &str) -> Result<Got, Error> {
    let server = &credentials.server;
    let failed =
        |reason: String| Error::new("JOBS_FAILED", format!("Couldn't read jobs: {reason}."));
    match api::call_as_machine(credentials, "GET", path, None) {
        Reply::Ok(body) => Ok(Got::Ok(body)),
        Reply::Revoked => Err(share::revoked(&credentials.machine.name)),
        Reply::Status(404, body) if body["error"]["code"] == "NOT_FOUND" => Ok(Got::NotFound),
        Reply::Status(404 | 405, _) => Err(failed(format!(
            "{server} doesn't share jobs with machines yet"
        ))),
        Reply::Status(status, body) => Err(failed(api::failure_reason(server, status, &body))),
        Reply::Unreachable(reason) => Err(failed(reason)),
    }
}

pub fn command(credentials: &Credentials, args: &[String]) -> Result<(), Error> {
    let args = parse(args)?;
    match args.id {
        Some(id) => show(credentials, id, args.json),
        None => list(credentials, &args),
    }
}

/// The list's query string, without the `?`.
fn query(args: &Args) -> String {
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    let pairs = [
        ("limit", args.limit.map(|n| n.to_string())),
        ("before", args.before.map(|n| n.to_string())),
        ("since", args.since.map(|n| n.to_string())),
        ("repo", args.repo.clone()),
        ("workflow", args.workflow.clone()),
        ("result", args.result.clone()),
    ];
    for (key, value) in pairs {
        if let Some(value) = value {
            query.append_pair(key, &value);
        }
    }
    query.finish()
}

fn list(credentials: &Credentials, args: &Args) -> Result<(), Error> {
    let query = query(args);
    let path = match query.is_empty() {
        true => "/api/machines/me/jobs".to_string(),
        false => format!("/api/machines/me/jobs?{query}"),
    };
    let page = match get(credentials, &path)? {
        Got::Ok(page) => page,
        Got::NotFound => json!({ "jobs": [], "next": null }),
    };
    if args.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&page).expect("serializes")
        );
        return Ok(());
    }
    let now = now_ms();
    for job in page["active"].as_array().into_iter().flatten() {
        let (what, since) = match job["startedAt"].as_u64() {
            Some(at) => ("running", at),
            None => ("waiting", job["queuedAt"].as_u64().unwrap_or(now)),
        };
        println!(
            "▸ {:<12}  {:<40}  {:>8}  {:>8}  {}",
            job["id"],
            title(job).chars().take(40).collect::<String>(),
            what,
            duration(now.saturating_sub(since)),
            job["repo"].as_str().unwrap_or(""),
        );
    }
    let jobs = page["jobs"].as_array().cloned().unwrap_or_default();
    if jobs.is_empty() {
        println!(
            "The gateway has no finished jobs from {} in the last week{}.",
            credentials.machine.name,
            if query.is_empty() { "" } else { " that match" }
        );
        return Ok(());
    }
    for job in &jobs {
        let ran = span(&job["startedAt"], &job["completedAt"])
            .map(duration)
            .unwrap_or_default();
        let when = job["completedAt"]
            .as_u64()
            .map(|at| ago(now.saturating_sub(at)))
            .unwrap_or_default();
        println!(
            "{} {:<12}  {:<40}  {:>8}  {:>8}  {}",
            mark(job["conclusion"].as_str()),
            job["id"],
            title(job).chars().take(40).collect::<String>(),
            ran,
            when,
            job["repo"].as_str().unwrap_or(""),
        );
    }
    if let Some(next) = page["next"].as_u64() {
        println!("\nOlder jobs: relayrunner jobs --before {next}");
    }
    println!("Steps for one job: relayrunner jobs <id>");
    Ok(())
}

/// One job with its steps and, when it failed, why. `--json` prints `{job, steps, failure}`.
fn show(credentials: &Credentials, id: u64, json: bool) -> Result<(), Error> {
    let not_here = || {
        Error::new(
            "NOT_FOUND",
            format!(
                "Job {id} didn't run on {}, or it's older than a week.",
                credentials.machine.name
            ),
        )
    };
    let Got::Ok(detail) = get(credentials, &format!("/api/machines/me/jobs/{id}"))? else {
        return Err(not_here());
    };
    // The gateway sends a failed job's failure with it. One that doesn't yet has it on its own.
    let failure = match detail.get("failure") {
        Some(failure) => failure.clone(),
        None if detail["job"]["conclusion"] == "failure" => {
            match get(credentials, &format!("/api/machines/me/jobs/{id}/failure"))? {
                Got::Ok(failure) => failure,
                Got::NotFound => Value::Null,
            }
        }
        None => Value::Null,
    };
    if json {
        let out = json!({ "job": detail["job"], "steps": detail["steps"], "failure": failure });
        println!(
            "{}",
            serde_json::to_string_pretty(&out).expect("serializes")
        );
        return Ok(());
    }
    let job = &detail["job"];
    println!("{} {}", mark(job["conclusion"].as_str()), title(job));
    println!(
        "  {}  {}",
        job["repo"].as_str().unwrap_or(""),
        job["url"].as_str().unwrap_or("")
    );
    match detail["steps"].as_array() {
        Some(steps) if !steps.is_empty() => {
            println!();
            for step in steps {
                let took = span(&step["startedAt"], &step["completedAt"])
                    .map(duration)
                    .unwrap_or_default();
                println!(
                    "  {} {:<48} {:>8}",
                    mark(step["conclusion"].as_str()),
                    step["name"].as_str().unwrap_or(""),
                    took
                );
            }
        }
        Some(_) => {}
        None => println!("\n  GitHub no longer has this job's steps."),
    }
    if !failure.is_null() {
        if let Some(step) = failure["failedStep"].as_str() {
            println!("\nFailed at {step}");
        }
        for note in failure["annotations"].as_array().into_iter().flatten() {
            println!("  {}", note.as_str().unwrap_or(""));
        }
        if let Some(log) = failure["log"].as_array() {
            println!();
            for line in log {
                println!("  {}", line.as_str().unwrap_or(""));
            }
        }
    }
    Ok(())
}

fn title(job: &Value) -> String {
    let name = job["name"].as_str().unwrap_or("Job");
    match job["workflow"].as_str() {
        Some(workflow) => format!("{workflow} › {name}"),
        None => name.to_string(),
    }
}

fn span(from: &Value, to: &Value) -> Option<u64> {
    Some(to.as_u64()?.saturating_sub(from.as_u64()?))
}

fn mark(conclusion: Option<&str>) -> &'static str {
    match conclusion {
        Some("success") => "✓",
        Some("failure" | "timed_out") => "✕",
        Some("cancelled" | "skipped") => "–",
        _ => "•",
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Result<Args, Error> {
        parse(&list.iter().map(|s| s.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn reads_a_page_or_a_job() {
        let page = args(&["--json", "--limit", "20", "--before", "1700000000000"]).unwrap();
        assert!(page.json && page.id.is_none());
        assert_eq!(
            (page.limit, page.before),
            (Some(20), Some(1_700_000_000_000))
        );
        assert_eq!(args(&["123", "--json"]).unwrap().id, Some(123));
        assert!(args(&["--limit", "0"]).is_err());
        assert!(args(&["--limit", "101"]).is_err());
        assert!(args(&["nope"]).is_err());
        assert!(args(&["1", "2"]).is_err());
    }

    #[test]
    fn filters_a_page() {
        let filtered = args(&[
            "--repo",
            "acme/app",
            "--workflow",
            "CI & deploy",
            "--result",
            "failed",
            "--since",
            "1700000000000",
        ])
        .unwrap();
        assert_eq!(
            query(&filtered),
            "since=1700000000000&repo=acme%2Fapp&workflow=CI+%26+deploy&result=failed"
        );
        assert_eq!(query(&args(&[]).unwrap()), "");
        assert!(args(&["--result", "maybe"]).is_err());
        assert!(args(&["--repo"]).is_err());
    }

    #[test]
    fn names_a_job_by_workflow_and_name() {
        assert_eq!(
            title(&json!({ "name": "test", "workflow": "CI" })),
            "CI › test"
        );
        assert_eq!(title(&json!({ "name": "test", "workflow": null })), "test");
        assert_eq!(span(&json!(1000), &json!(4000)), Some(3000));
        assert_eq!(span(&json!(null), &json!(4000)), None);
    }
}
