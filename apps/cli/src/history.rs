//! The jobs this machine ran, newest last, one JSON object per line in
//! ~/.relayrunner/history.jsonl. `connect` appends a line when each job's runner exits, the Mac
//! app reads the file for its Recent list, and `relayrunner history` prints it.

use crate::error::Error;
use crate::protocol::{JobState, JobUsage, RunJob};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// How many jobs the file keeps. Older lines are dropped once it holds twice as many.
pub const KEEP: usize = 500;

pub const FORMAT: u32 = 1;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub v: u32,
    pub route_id: String,
    /// owner/name, from the job's runner config or the gateway.
    pub repo: Option<String>,
    pub workflow: Option<String>,
    /// The job's name: the gateway's, else the runner's own line for it.
    pub job: Option<String>,
    /// The job's page on GitHub, when the gateway sent it.
    pub url: Option<String>,
    pub run_attempt: Option<u32>,
    /// GitHub's result as the runner printed it: Succeeded, Failed, Canceled and so on. None when
    /// the runner exited before saying.
    pub result: Option<String>,
    /// Whether the runner exited cleanly (`finished`) or not (`failed`).
    pub state: JobState,
    /// Why the runner failed, when it did.
    pub message: Option<String>,
    pub slot: u32,
    pub started_at: String,
    pub started_at_ms: u64,
    pub duration_ms: u64,
    /// How long the job usually runs on this machine, as the gateway said when it sent the job.
    pub typical_ms: Option<u64>,
    pub usage: Option<JobUsage>,
}

/// What a job run knows by the time its runner exits.
pub struct Finished<'a> {
    pub route_id: &'a str,
    pub repo: Option<String>,
    pub job: Option<&'a RunJob>,
    /// The runner's own name for the job and its result, from its last line.
    pub runner_result: Option<(String, String)>,
    pub state: JobState,
    pub message: Option<String>,
    pub slot: u32,
    pub started_at: String,
    pub started_at_ms: u64,
    pub duration_ms: u64,
    pub usage: Option<JobUsage>,
}

impl Entry {
    pub fn from(done: Finished) -> Entry {
        let (runner_job, result) = done.runner_result.unzip();
        Entry {
            v: FORMAT,
            route_id: done.route_id.to_string(),
            repo: done.job.map(|j| j.repo.clone()).or(done.repo),
            workflow: done.job.and_then(|j| j.workflow.clone()),
            job: done.job.map(|j| j.name.clone()).or(runner_job),
            url: done.job.map(|j| j.url.clone()),
            run_attempt: done.job.map(|j| j.run_attempt),
            result,
            state: done.state,
            message: done.message,
            slot: done.slot,
            started_at: done.started_at,
            started_at_ms: done.started_at_ms,
            duration_ms: done.duration_ms,
            typical_ms: done.job.and_then(|j| j.typical_ms),
            usage: done.usage,
        }
    }
}

pub fn path() -> PathBuf {
    crate::credentials::home().join("history.jsonl")
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// Adds a job to the end of the file, trimming it to the newest KEEP once it holds twice that.
/// A history that can't be written never fails the job.
pub fn append(file: &Path, entry: &Entry) {
    let Ok(line) = serde_json::to_string(entry) else {
        return;
    };
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let written = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(file)
        .and_then(|mut f| writeln!(f, "{line}"));
    if written.is_ok() {
        trim(file, KEEP);
    }
}

fn trim(file: &Path, keep: usize) {
    let Ok(text) = std::fs::read_to_string(file) else {
        return;
    };
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    if lines.len() <= keep * 2 {
        return;
    }
    let kept = lines[lines.len() - keep..].join("\n") + "\n";
    // Through a temporary file, so a reader never sees half a file.
    let temp = file.with_extension("jsonl.tmp");
    if std::fs::write(&temp, kept).is_ok() {
        let _ = std::fs::rename(&temp, file);
    }
}

/// The newest `limit` jobs, newest first. Lines this version can't read are skipped.
pub fn read(file: &Path, limit: usize) -> Vec<Entry> {
    let Ok(f) = std::fs::File::open(file) else {
        return Vec::new();
    };
    let mut entries: Vec<Entry> = std::io::BufReader::new(f)
        .lines()
        .map_while(Result::ok)
        .filter_map(|line| serde_json::from_str(&line).ok())
        .collect();
    entries.reverse();
    entries.truncate(limit);
    entries
}

/// `relayrunner history [--json] [--limit N]`.
pub fn command(args: &[String]) -> Result<(), Error> {
    let mut json = false;
    let mut limit = 20;
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--json" => json = true,
            "--limit" => {
                limit = rest
                    .next()
                    .and_then(|n| n.parse().ok())
                    .filter(|n| *n > 0)
                    .ok_or_else(|| {
                        Error::new("INVALID_ARGUMENT", "--limit takes a number above 0.")
                    })?;
            }
            other => {
                return Err(Error::new(
                    "INVALID_ARGUMENT",
                    format!(
                        "Unknown option {other:?}. Usage: relayrunner history [--json] [--limit N]"
                    ),
                ));
            }
        }
    }
    let entries = read(&path(), limit);
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&entries).unwrap_or_else(|_| "[]".into())
        );
        return Ok(());
    }
    if entries.is_empty() {
        println!(
            "No jobs have run on this machine yet. Jobs show here once `relayrunner connect` runs one."
        );
        return Ok(());
    }
    let now = now_ms();
    let name_width = entries
        .iter()
        .map(|e| title(e).chars().count())
        .max()
        .unwrap_or(0)
        .min(48);
    for entry in &entries {
        let title = title(entry);
        let title: String = title.chars().take(48).collect();
        let repo = entry.repo.as_deref().unwrap_or("");
        println!(
            "{} {title:<name_width$}  {:<8}  {:>8}  {:>8}  {repo}",
            mark(entry),
            outcome(entry),
            duration(entry.duration_ms),
            ago(now.saturating_sub(entry.started_at_ms + entry.duration_ms)),
        );
    }
    Ok(())
}

fn title(entry: &Entry) -> String {
    match (&entry.workflow, &entry.job) {
        (Some(workflow), Some(job)) => format!("{workflow} › {job}"),
        (None, Some(job)) => job.clone(),
        _ => format!("Job {}", entry.route_id),
    }
}

/// GitHub's result, else whether the runner itself failed.
pub fn outcome(entry: &Entry) -> String {
    match (&entry.result, &entry.state) {
        (Some(result), _) => result.clone(),
        (None, JobState::Failed) => "Error".into(),
        (None, _) => "Done".into(),
    }
}

fn mark(entry: &Entry) -> &'static str {
    match outcome(entry).as_str() {
        "Succeeded" => "✓",
        "Failed" | "Error" => "✕",
        "Canceled" => "–",
        _ => "•",
    }
}

/// 45s, 4m 10s, 1h 02m.
pub fn duration(ms: u64) -> String {
    let secs = ms / 1000;
    match secs {
        0..60 => format!("{secs}s"),
        60..3600 => format!("{}m {:02}s", secs / 60, secs % 60),
        _ => format!("{}h {:02}m", secs / 3600, secs % 3600 / 60),
    }
}

/// just now, 12m ago, 3h ago, 2d ago.
pub fn ago(ms: u64) -> String {
    let mins = ms / 60_000;
    match mins {
        0 => "just now".into(),
        1..60 => format!("{mins}m ago"),
        60..1440 => format!("{}h ago", mins / 60),
        _ => format!("{}d ago", mins / 1440),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(route_id: &str) -> Entry {
        Entry::from(Finished {
            route_id,
            repo: Some("acme/app".into()),
            job: None,
            runner_result: Some(("test".into(), "Succeeded".into())),
            state: JobState::Finished,
            message: None,
            slot: 1,
            started_at: "2026-11-18T10:00:00.000Z".into(),
            started_at_ms: 1_000,
            duration_ms: 250_000,
            usage: None,
        })
    }

    fn temp() -> PathBuf {
        std::env::temp_dir().join(format!("rr-history-{}.jsonl", fastrand::u64(..)))
    }

    #[test]
    fn keeps_jobs_newest_first() {
        let file = temp();
        for id in ["a", "b", "c"] {
            append(&file, &entry(id));
        }
        let read = read(&file, 2);
        assert_eq!(
            read.iter().map(|e| e.route_id.as_str()).collect::<Vec<_>>(),
            ["c", "b"]
        );
        assert_eq!(read[0].job.as_deref(), Some("test"));
        assert_eq!(read[0].result.as_deref(), Some("Succeeded"));
        std::fs::remove_file(file).unwrap();
    }

    #[test]
    fn prefers_what_the_gateway_said() {
        let job = RunJob {
            name: "test (18)".into(),
            workflow: Some("CI".into()),
            repo: "acme/app".into(),
            url: "https://github.com/acme/app/actions/runs/1/job/2".into(),
            run_attempt: 2,
            typical_ms: Some(300_000),
        };
        let entry = Entry::from(Finished {
            route_id: "r",
            repo: None,
            job: Some(&job),
            runner_result: Some(("test".into(), "Failed".into())),
            state: JobState::Finished,
            message: None,
            slot: 2,
            started_at: String::new(),
            started_at_ms: 0,
            duration_ms: 1,
            usage: None,
        });
        assert_eq!(entry.job.as_deref(), Some("test (18)"));
        assert_eq!(entry.workflow.as_deref(), Some("CI"));
        assert_eq!(entry.typical_ms, Some(300_000));
        assert_eq!(entry.result.as_deref(), Some("Failed"));
        assert_eq!(entry.run_attempt, Some(2));
    }

    #[test]
    fn trims_to_the_newest() {
        let file = temp();
        for i in 0..7 {
            append(&file, &entry(&i.to_string()));
        }
        trim(&file, 3);
        let ids: Vec<_> = read(&file, 10).into_iter().map(|e| e.route_id).collect();
        assert_eq!(ids, ["6", "5", "4"]);
        std::fs::remove_file(file).unwrap();
    }

    #[test]
    fn skips_lines_it_cant_read() {
        let file = temp();
        std::fs::write(&file, "not json\n{\"v\":1}\n").unwrap();
        append(&file, &entry("ok"));
        assert_eq!(read(&file, 10).len(), 1);
        std::fs::remove_file(file).unwrap();
    }

    #[test]
    fn writes_short_times() {
        assert_eq!(duration(45_000), "45s");
        assert_eq!(duration(250_000), "4m 10s");
        assert_eq!(duration(3_720_000), "1h 02m");
        assert_eq!(ago(30_000), "just now");
        assert_eq!(ago(12 * 60_000), "12m ago");
        assert_eq!(ago(3 * 3_600_000), "3h ago");
    }
}
