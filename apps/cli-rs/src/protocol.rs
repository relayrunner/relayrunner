//! The machine WebSocket messages, mirroring packages/machine-protocol/src/messages.ts.
//! Only what `connect` sends and reads; the gateway side stays in TypeScript.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_cores: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os_version: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    pub machine_id: String,
    pub os: &'static str,
    pub arch: &'static str,
    pub runner_version: String,
    pub cli_version: String,
    pub device: Device,
    pub rotates_token: bool,
    pub slots: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum JobState {
    Started,
    Finished,
    Failed,
}

/// A `job` message without its envelope.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct JobUpdate {
    pub route_id: String,
    pub state: JobState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

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

    #[test]
    fn encodes_with_version() {
        let text = MachineMessage::TokenSaved.encode();
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["type"], "token_saved");
        assert_eq!(value["v"], 1);
    }

    #[test]
    fn status_leaves_out_unchanged_version() {
        let text = MachineMessage::Status {
            state: "idle",
            running: 0,
            runner_version: None,
        }
        .encode();
        assert!(!text.contains("runnerVersion"));
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
