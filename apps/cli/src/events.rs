//! `connect --events`: for an app that runs `connect` on someone's behalf, such as the Mac menu bar
//! app.
//!
//! stdout carries one JSON object per line and nothing else: everything `connect` would print for
//! a person, job output included, goes to stderr instead. Each object has `v` (this format's
//! version), `at` (an ISO time) and `type`, then the fields of one [`Event`], which is the whole
//! format. `fixtures/events.jsonl` holds one line of each kind the Mac app reads; a test here
//! checks the CLI still writes them, and the app's EventTests.swift checks it still reads them.
//! stdin takes one command per line: `pause` or `resume`.
//!
//! To go offline the way Ctrl-C does, start `connect` in its own process group and send that group
//! SIGINT (a second one exits on the spot). Closing stdin goes offline too, for when the app quits
//! or crashes, and lets a running job finish.

use crate::history;
use crate::protocol::{JobUpdate, QueueEntry, RunJob};
use serde::Serialize;
use serde_json::{Value, json};
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// One line of `connect --events`.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum Event {
    /// The page to approve this machine on, and the code it shows.
    SignIn {
        url: String,
        code: String,
    },
    /// Once signed in.
    Machine {
        id: String,
        name: String,
        server: String,
    },
    Connecting {
        attempt: u32,
    },
    Connected {},
    Disconnected {
        code: u16,
        reason: String,
        retry_in_ms: u64,
    },
    GatewayError {
        code: String,
        message: String,
    },
    /// How many jobs wait for a slot here, the longest-waiting of them, and when jobs in the last
    /// hour went elsewhere because every slot was busy.
    Waiting {
        jobs: u32,
        queue: Vec<QueueEntry>,
        spilled: Vec<u64>,
    },
    Paused {
        paused: bool,
        by: Option<String>,
    },
    TokenNotSaved {
        message: String,
    },
    RunRefused {
        route_id: String,
        running: usize,
    },
    /// A job handed to a slot (from 1), with which job it is when the gateway said.
    Run {
        route_id: String,
        slot: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        job: Option<RunJob>,
    },
    Job {
        update: JobUpdate,
        slot: u32,
    },
    /// The machine's state after each of the connection's events.
    State(State),
    JobRepo {
        route_id: String,
        repo: String,
    },
    /// The job's name and GitHub's result for it, from the runner.
    JobResult {
        route_id: String,
        job: String,
        result: String,
    },
    /// The line `connect` adds to ~/.relayrunner/history.jsonl (history.rs).
    JobEnd(history::Entry),
    Offline {
        reason: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    /// `command` is set when a command on stdin failed; without it, `connect` is stopping.
    Error {
        code: String,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        command: Option<String>,
    },
}

/// The machine's state: its link to the gateway, whether it's paused, the route ids of the jobs
/// running now, the jobs waiting for a slot (see `Waiting`) and how many it runs at once.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct State {
    pub link: &'static str,
    pub paused: bool,
    pub jobs: Vec<String>,
    pub waiting: u32,
    pub queue: Vec<QueueEntry>,
    pub spilled: Vec<u64>,
    pub slots: u32,
}

impl Event {
    pub fn error(code: impl Into<String>, message: impl Into<String>) -> Event {
        Event::Error {
            code: code.into(),
            message: message.into(),
            command: None,
        }
    }
}

static ON: AtomicBool = AtomicBool::new(false);

pub fn start() {
    ON.store(true, Ordering::Relaxed);
}

pub fn on() -> bool {
    ON.load(Ordering::Relaxed)
}

/// Writes the event's line to stdout when events are on.
pub fn emit(event: &Event) {
    if !on() {
        return;
    }
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{}", line(event, &now_iso()));
    let _ = out.flush();
}

/// `{v, at, type, ...fields}`.
fn line(event: &Event, at: &str) -> Value {
    let mut line = json!({ "v": 1, "at": at });
    if let (Some(line), Ok(Value::Object(fields))) =
        (line.as_object_mut(), serde_json::to_value(event))
    {
        line.extend(fields);
    }
    line
}

/// A line for a person, as clack's log.info: stderr when stdout carries events, stdout otherwise.
pub fn log(line: &str) {
    crate::ui::info(line);
}

/// The time as JavaScript's toISOString writes it: 2026-11-16T22:28:36.123Z.
pub fn now_iso() -> String {
    let since = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = since.as_secs() as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60,
        since.subsec_millis()
    )
}

/// The local time of day, such as 14:03:09, for log lines.
pub fn local_time() -> String {
    // SAFETY: localtime_r writes only into the struct we pass.
    unsafe {
        let now = libc::time(std::ptr::null_mut());
        let mut tm: libc::tm = std::mem::zeroed();
        libc::localtime_r(&now, &mut tm);
        format!("{:02}:{:02}:{:02}", tm.tm_hour, tm.tm_min, tm.tm_sec)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{JobState, JobUsage};

    /// One of each event the Mac app reads, in the order of fixtures/events.jsonl.
    fn samples() -> Vec<Event> {
        let job = RunJob {
            name: "test".into(),
            workflow: Some("CI".into()),
            repo: "acme/app".into(),
            url: "https://github.com/acme/app/actions/runs/1/job/2".into(),
            run_attempt: 1,
            typical_ms: Some(150_000),
        };
        let queue = vec![QueueEntry {
            repo: "acme/app".into(),
            since: 1_763_481_600_000,
            name: Some("test".into()),
            workflow: Some("CI".into()),
        }];
        vec![
            Event::SignIn {
                url: "https://app.relayrunner.dev/device?user_code=ABCD-EFGH".into(),
                code: "ABCD-EFGH".into(),
            },
            Event::Machine {
                id: "m1".into(),
                name: "ada-mbp".into(),
                server: "https://app.relayrunner.dev/".into(),
            },
            Event::Connecting { attempt: 1 },
            Event::Connected {},
            Event::State(State {
                link: "online",
                paused: false,
                jobs: vec![],
                waiting: 0,
                queue: vec![],
                spilled: vec![],
                slots: 2,
            }),
            Event::Waiting {
                jobs: 1,
                queue: queue.clone(),
                spilled: vec![1_763_481_000_000],
            },
            Event::State(State {
                link: "online",
                paused: true,
                jobs: vec!["r1".into()],
                waiting: 1,
                queue,
                spilled: vec![1_763_481_000_000],
                slots: 2,
            }),
            Event::Paused {
                paused: true,
                by: Some("octocat".into()),
            },
            Event::Run {
                route_id: "r1".into(),
                slot: 1,
                job: Some(job.clone()),
            },
            Event::Run {
                route_id: "r2".into(),
                slot: 2,
                job: None,
            },
            Event::JobRepo {
                route_id: "r1".into(),
                repo: "acme/app".into(),
            },
            Event::Job {
                update: JobUpdate {
                    route_id: "r1".into(),
                    state: JobState::Started,
                    message: None,
                    usage: None,
                },
                slot: 1,
            },
            Event::JobResult {
                route_id: "r1".into(),
                job: "test".into(),
                result: "Failed".into(),
            },
            Event::JobEnd(history::Entry {
                v: 1,
                route_id: "r1".into(),
                repo: Some("acme/app".into()),
                workflow: Some("CI".into()),
                job: Some("test".into()),
                url: Some(job.url),
                run_attempt: Some(1),
                result: Some("Failed".into()),
                state: JobState::Finished,
                message: None,
                slot: 1,
                started_at: "2026-11-23T14:00:00.000Z".into(),
                started_at_ms: 1_763_906_400_000,
                duration_ms: 152_000,
                typical_ms: Some(150_000),
                usage: Some(JobUsage {
                    cpu_p95: 0.82,
                    cpu_peak: 0.97,
                    memory_p95_mb: 1_800,
                    memory_peak_mb: 2_048,
                    cpus: 4,
                    memory_mb: 8_192,
                    samples: 30,
                }),
            }),
            Event::Disconnected {
                code: 1006,
                reason: String::new(),
                retry_in_ms: 1_200,
            },
            Event::Offline {
                reason: "stopped",
                message: None,
            },
            Event::Offline {
                reason: "rejected",
                message: Some("This machine was removed from the workspace.".into()),
            },
            Event::error("NOT_SIGNED_IN", "Sign in first."),
            Event::Error {
                code: "UNKNOWN_COMMAND".into(),
                message: "Commands are `pause` and `resume`.".into(),
                command: Some("bogus".into()),
            },
        ]
    }

    const FIXTURE: &str = "fixtures/events.jsonl";

    /// The lines the CLI writes are the ones in the fixture, which the Mac app's tests read.
    /// `UPDATE_FIXTURES=1 cargo test` rewrites it after a deliberate change.
    #[test]
    fn writes_the_fixture_lines() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(FIXTURE);
        let written: String = samples()
            .iter()
            .map(|event| format!("{}\n", line(event, "2026-11-23T14:00:00.000Z")))
            .collect();
        if std::env::var_os("UPDATE_FIXTURES").is_some() {
            std::fs::write(&path, &written).unwrap();
        }
        let fixture = std::fs::read_to_string(&path).unwrap();
        for (wrote, expected) in written.lines().zip(fixture.lines()) {
            assert_eq!(wrote, expected);
        }
        assert_eq!(written.lines().count(), fixture.lines().count());
    }
}
