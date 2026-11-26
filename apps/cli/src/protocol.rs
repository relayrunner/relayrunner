//! The machine WebSocket messages, mirroring packages/machine-protocol/src/messages.ts.
//! Only what `connect` sends and reads; the gateway side stays in TypeScript.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chip: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_cores: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_mb: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os_version: Option<String>,
}

/// Where a VM-per-job place runs, beside the machine's own OS.
#[derive(Serialize, Clone, Debug)]
pub struct Place {
    pub os: &'static str,
    pub arch: &'static str,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VmSize {
    pub cpus: u32,
    pub memory_gb: u32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    pub machine_id: String,
    pub os: &'static str,
    pub arch: &'static str,
    pub runner_version: String,
    pub cli_version: String,
    /// The Mac app's version, when the Mac app runs this CLI.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mac_app_version: Option<String>,
    pub device: Device,
    pub rotates_token: bool,
    /// Always true: this CLI reads `waiting` messages.
    pub hears_waiting: bool,
    pub slots: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub isolated: Option<Place>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vm: Option<VmSize>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum JobState {
    Started,
    Finished,
    Failed,
}

/// A `job` message without its envelope.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JobUpdate {
    pub route_id: String,
    pub state: JobState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<JobUsage>,
}

/// CPU (a 0-1 share of what the job could use) and memory, sampled while the runner ran.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JobUsage {
    pub cpu_p95: f64,
    pub cpu_peak: f64,
    pub memory_p95_mb: u64,
    pub memory_peak_mb: u64,
    pub cpus: u32,
    pub memory_mb: u64,
    pub samples: u32,
}

// Hello is much bigger than the rest, but it's sent once per connection, so boxing it buys nothing.
#[allow(clippy::large_enum_variant)]
#[derive(Serialize, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MachineMessage {
    Hello(Hello),
    Status {
        state: &'static str,
        running: u32,
        #[serde(rename = "runnerVersion", skip_serializing_if = "Option::is_none")]
        runner_version: Option<String>,
    },
    Job(JobUpdate),
    TokenSaved,
}

impl MachineMessage {
    pub fn encode(&self) -> String {
        let mut value = serde_json::to_value(self).expect("messages always serialize");
        value
            .as_object_mut()
            .expect("messages are objects")
            .insert("v".into(), PROTOCOL_VERSION.into());
        value.to_string()
    }
}

/// Which job a `run` message hands the machine, when the gateway knows.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunJob {
    pub name: String,
    pub workflow: Option<String>,
    pub repo: String,
    pub url: String,
    #[serde(default = "first_attempt")]
    pub run_attempt: u32,
    /// The median of the job's recent successful runs on this machine.
    pub typical_ms: Option<u64>,
}

fn first_attempt() -> u32 {
    1
}

impl RunJob {
    /// The `job` of a `run` message, or None when it's missing or unreadable.
    pub fn read(value: Option<Value>) -> Option<RunJob> {
        serde_json::from_value(value?).ok()
    }
}

#[derive(Deserialize, Debug, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum GatewayMessage {
    Run {
        #[serde(rename = "routeId")]
        route_id: String,
        #[serde(rename = "jitConfig")]
        jit_config: String,
        #[serde(default)]
        isolated: bool,
        /// Read with `RunJob::read`, so a job the CLI can't read never refuses the run.
        #[serde(default)]
        job: Option<Value>,
    },
    Error {
        code: String,
        message: String,
    },
    Paused {
        paused: bool,
        by: Option<String>,
    },
    Token {
        token: String,
    },
    /// How many jobs are waiting for a slot on this machine, the longest-waiting of them, and
    /// when jobs in the last hour went elsewhere because every slot was busy.
    Waiting {
        jobs: u32,
        #[serde(default)]
        queue: Vec<QueueEntry>,
        #[serde(default)]
        spilled: Vec<u64>,
    },
}

/// A job waiting for a slot: its repo, since when in ms since the epoch, and its name and workflow
/// once the gateway knows which job it is.
#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
pub struct QueueEntry {
    pub repo: String,
    pub since: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow: Option<String>,
}

/// A text frame from the gateway, or why it was rejected. Checks the version before the shape,
/// as the TypeScript side does.
pub fn parse_gateway(frame: &str) -> Result<GatewayMessage, (&'static str, String)> {
    let value: Value = serde_json::from_str(frame).map_err(|e| ("invalid_json", e.to_string()))?;
    let v = value.get("v");
    if v.and_then(Value::as_u64) != Some(PROTOCOL_VERSION as u64) {
        let got = v.map_or("none".to_string(), Value::to_string);
        return Err((
            "version_mismatch",
            format!("expected protocol version {PROTOCOL_VERSION}, got {got}"),
        ));
    }
    let message: GatewayMessage =
        serde_json::from_value(value).map_err(|e| ("invalid_message", e.to_string()))?;
    if let GatewayMessage::Run {
        route_id,
        jit_config,
        ..
    } = &message
        && (route_id.is_empty() || jit_config.is_empty())
    {
        return Err((
            "invalid_message",
            "routeId and jitConfig can't be empty".into(),
        ));
    }
    Ok(message)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixtures() -> Value {
        let text = include_str!("../../../packages/machine-protocol/fixtures.json");
        serde_json::from_str(text).unwrap()
    }

    fn same(name: &str, message: MachineMessage) {
        let sent: Value = serde_json::from_str(&message.encode()).unwrap();
        assert_eq!(sent, fixtures()["machine"][name], "{name}");
    }

    #[test]
    fn sends_the_shared_machine_fixtures() {
        same(
            "hello",
            MachineMessage::Hello(Hello {
                machine_id: "mch_1".into(),
                os: "macos",
                arch: "arm64",
                runner_version: "2.330.0".into(),
                cli_version: "0.13.0".into(),
                mac_app_version: Some("0.2.0".into()),
                device: Device {
                    kind: "laptop",
                    model: Some("MacBook Pro".into()),
                    model_id: Some("Mac15,9".into()),
                    chip: Some("Apple M3 Pro".into()),
                    cpu_cores: Some(12),
                    memory_mb: Some(36864),
                    os_version: Some("macOS 15.1".into()),
                },
                rotates_token: true,
                hears_waiting: true,
                slots: 2,
                isolated: Some(Place {
                    os: "linux",
                    arch: "arm64",
                }),
                vm: Some(VmSize {
                    cpus: 4,
                    memory_gb: 8,
                }),
            }),
        );
        same(
            "statusIdle",
            MachineMessage::Status {
                state: "idle",
                running: 0,
                runner_version: None,
            },
        );
        same(
            "statusBusy",
            MachineMessage::Status {
                state: "busy",
                running: 1,
                runner_version: Some("2.331.0".into()),
            },
        );
        let job = |state, message: Option<&str>, usage| {
            MachineMessage::Job(JobUpdate {
                route_id: "rt_1".into(),
                state,
                message: message.map(Into::into),
                usage,
            })
        };
        same("jobStarted", job(JobState::Started, None, None));
        let usage = JobUsage {
            cpu_p95: 0.5,
            cpu_peak: 0.75,
            memory_p95_mb: 900,
            memory_peak_mb: 1200,
            cpus: 4,
            memory_mb: 8192,
            samples: 12,
        };
        same("jobFinished", job(JobState::Finished, None, Some(usage)));
        same(
            "jobFailed",
            job(JobState::Failed, Some("The runner exited with 1"), None),
        );
        same("tokenSaved", MachineMessage::TokenSaved);
        assert_eq!(
            fixtures()["machine"].as_object().unwrap().len(),
            7,
            "a machine fixture isn't checked here"
        );
    }

    #[test]
    fn reads_every_shared_gateway_fixture() {
        for (name, message) in fixtures()["gateway"].as_object().unwrap() {
            let parsed = parse_gateway(&message.to_string());
            assert!(parsed.is_ok(), "{name}: {parsed:?}");
        }
    }

    #[test]
    fn reads_what_waits_and_what_went_elsewhere() {
        let Ok(GatewayMessage::Waiting {
            jobs,
            queue,
            spilled,
        }) = parse_gateway(&fixtures()["gateway"]["waiting"].to_string())
        else {
            panic!("waiting should parse");
        };
        assert_eq!(jobs, 3);
        assert_eq!(
            queue,
            vec![
                QueueEntry {
                    repo: "octo/app".into(),
                    since: 1_763_481_600_000,
                    name: Some("test".into()),
                    workflow: Some("CI".into()),
                },
                QueueEntry {
                    repo: "octo/app".into(),
                    since: 1_763_481_700_000,
                    name: None,
                    workflow: None,
                },
            ]
        );
        assert_eq!(spilled, vec![1_763_481_000_000]);
        let Ok(GatewayMessage::Waiting { queue, spilled, .. }) =
            parse_gateway(&fixtures()["gateway"]["waitingCountOnly"].to_string())
        else {
            panic!("an older gateway's waiting should parse");
        };
        assert!(queue.is_empty() && spilled.is_empty());
    }

    #[test]
    fn reads_the_job_a_run_names() {
        let Ok(GatewayMessage::Run { job, .. }) =
            parse_gateway(&fixtures()["gateway"]["runWithJob"].to_string())
        else {
            panic!("runWithJob should parse");
        };
        assert_eq!(
            RunJob::read(job),
            Some(RunJob {
                name: "test".into(),
                workflow: Some("CI".into()),
                repo: "acme/app".into(),
                url: "https://github.com/acme/app/actions/runs/42/job/7".into(),
                run_attempt: 1,
                typical_ms: Some(312_000),
            })
        );
        let odd = parse_gateway(
            r#"{"v":1,"type":"run","routeId":"r1","jitConfig":"abc","job":{"name":3}}"#,
        );
        let Ok(GatewayMessage::Run { job, .. }) = odd else {
            panic!("a run with an unreadable job still runs");
        };
        assert_eq!(RunJob::read(job), None);
    }

    #[test]
    fn reads_run_and_rejects_other_versions() {
        let run =
            parse_gateway(r#"{"v":1,"type":"run","routeId":"r1","jitConfig":"abc"}"#).unwrap();
        assert!(matches!(
            run,
            GatewayMessage::Run {
                isolated: false,
                ..
            }
        ));
        assert_eq!(
            parse_gateway(r#"{"v":2,"type":"run"}"#).unwrap_err().0,
            "version_mismatch"
        );
        assert_eq!(
            parse_gateway(r#"{"v":1,"type":"nope"}"#).unwrap_err().0,
            "invalid_message"
        );
        assert_eq!(parse_gateway("{").unwrap_err().0, "invalid_json");
    }
}
