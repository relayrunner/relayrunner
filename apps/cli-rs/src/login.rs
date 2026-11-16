//! Signs this computer in as a machine with the browser device-code flow. A port of
//! apps/cli/login.ts: get a code, wait for approval, then trade the session for a machine token.

use crate::api::{self, Reply};
use crate::credentials::{Credentials, Machine};
use crate::error::Error;
use serde_json::{Value, json};
use std::time::{Duration, Instant};

const CLIENT_ID: &str = "relayrunner-cli";
const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";

/// One of the machine's workspaces, as the sign-in reports it.
pub struct Workspace {
    pub name: String,
    pub member_count: Option<u64>,
}

pub struct SignedIn {
    pub credentials: Credentials,
    pub workspaces: Vec<Workspace>,
}

/// The workspaces in a sign-in or whoami body: the list, or the single one an older gateway sends.
pub fn read_workspaces(body: &Value) -> Vec<Workspace> {
    let list = match &body["workspaces"] {
        Value::Array(list) => list.clone(),
        _ if body["workspace"].is_object() => vec![body["workspace"].clone()],
        _ => Vec::new(),
    };
    list.iter()
        .filter_map(|w| {
            Some(Workspace {
                name: w["name"].as_str()?.to_string(),
                member_count: w["memberCount"].as_u64(),
            })
        })
        .collect()
}

/// Signs in. `on_code` gets the approval link and the code, and should show them and open the
/// browser; polling starts once it returns.
pub fn login(
    server: &str,
    name: &str,
    platform: (&str, &str),
    on_code: impl FnOnce(&str, &str),
) -> Result<SignedIn, Error> {
    let post = |path: &str, body: Value, bearer: Option<&str>| {
        api::call(server, "POST", path, bearer, Some(&body))
    };

    let code = match post(
        "/api/auth/device/code",
        json!({ "client_id": CLIENT_ID }),
        None,
    ) {
        Reply::Ok(body) => body,
        Reply::Unreachable(_) => {
            return Err(Error::new(
                "UNREACHABLE",
                format!("Couldn't reach RelayRunner at {server}."),
            ));
        }
        Reply::Revoked => {
            return Err(Error::new(
                "CODE_FAILED",
                format!("The gateway at {server} wouldn't start a sign-in (HTTP 401)."),
            ));
        }
        Reply::Status(status, _) => {
            return Err(Error::new(
                "CODE_FAILED",
                format!("The gateway at {server} wouldn't start a sign-in (HTTP {status})."),
            ));
        }
    };
    let field = |key: &str| {
        code[key]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let (Some(device_code), Some(user_code), Some(uri), Some(expires_in)) = (
        field("device_code"),
        field("user_code"),
        field("verification_uri_complete").or_else(|| field("verification_uri")),
        code["expires_in"].as_f64().filter(|n| *n > 0.0),
    ) else {
        return Err(Error::new(
            "CODE_FAILED",
            format!("{server} sent an unexpected sign-in code."),
        ));
    };

    let mut url = url::Url::parse(&uri)
        .map_err(|_| Error::new("CODE_FAILED", format!("{server} sent a bad sign-in link.")))?;
    let has_code = url.query_pairs().any(|(k, _)| k == "user_code");
    {
        let mut query = url.query_pairs_mut();
        if !has_code {
            query.append_pair("user_code", &user_code);
        }
        query.append_pair("name", name);
    }
    let expires = Instant::now() + Duration::from_secs_f64(expires_in);
    on_code(url.as_str(), &user_code);

    let expired = || {
        Error::new(
            "EXPIRED",
            "The sign-in code expired before it was approved.",
        )
    };
    let mut interval = Duration::from_secs_f64(
        code["interval"]
            .as_f64()
            .filter(|n| *n > 0.0)
            .unwrap_or(5.0),
    );
    let access_token = loop {
        if Instant::now() >= expires {
            return Err(expired());
        }
        std::thread::sleep(interval);
        let body = json!({ "grant_type": DEVICE_GRANT, "device_code": device_code, "client_id": CLIENT_ID });
        match post("/api/auth/device/token", body, None) {
            Reply::Ok(body) => match body["access_token"].as_str() {
                Some(token) if !token.is_empty() => break token.to_string(),
                _ => {
                    return Err(Error::new(
                        "TOKEN_FAILED",
                        "Signing in failed: no access token.",
                    ));
                }
            },
            // A network blip: try again on the next tick.
            Reply::Unreachable(_) => {}
            Reply::Revoked => {
                return Err(Error::new("TOKEN_FAILED", "Signing in failed: HTTP 401."));
            }
            Reply::Status(status, body) => match body["error"].as_str() {
                Some("authorization_pending") => {}
                Some("slow_down") => interval += Duration::from_secs(5),
                Some("access_denied") => {
                    return Err(Error::new(
                        "DENIED",
                        "The sign-in was denied in the browser.",
                    ));
                }
                Some("expired_token") => return Err(expired()),
                _ if status >= 500 => {}
                other => {
                    let why = body["error_description"]
                        .as_str()
                        .or(other)
                        .map_or(format!("HTTP {status}"), str::to_owned);
                    return Err(Error::new(
                        "TOKEN_FAILED",
                        format!("Signing in failed: {why}."),
                    ));
                }
            },
        }
    };

    let claim = json!({ "deviceCode": device_code, "os": platform.0, "arch": platform.1 });
    let claimed = match post("/api/machines/claim", claim, Some(&access_token)) {
        Reply::Ok(body) => body,
        Reply::Revoked => return Err(claim_failed(server, "HTTP 401".into())),
        Reply::Status(status, body) => {
            return Err(claim_failed(
                server,
                api::failure_reason(server, status, &body),
            ));
        }
        Reply::Unreachable(reason) => return Err(claim_failed(server, reason)),
    };
    let (Some(id), Some(machine_name), Some(token)) = (
        claimed["machine"]["id"].as_str(),
        claimed["machine"]["name"].as_str(),
        claimed["token"].as_str(),
    ) else {
        return Err(claim_failed(
            server,
            "it sent an unexpected response".into(),
        ));
    };
    let origin = url::Url::parse(server)
        .map(|u| u.origin().ascii_serialization())
        .unwrap_or_else(|_| server.to_string());
    Ok(SignedIn {
        credentials: Credentials {
            server: origin,
            machine: Machine {
                id: id.to_string(),
                name: machine_name.to_string(),
            },
            token: token.to_string(),
        },
        workspaces: read_workspaces(&claimed),
    })
}

fn claim_failed(server: &str, reason: String) -> Error {
    let _ = server;
    Error::new(
        "CLAIM_FAILED",
        format!("The gateway approved the sign-in but wouldn't enroll this machine: {reason}."),
    )
}

/// Best effort: when no browser opens, the link is on screen.
pub fn open_browser(url: &str) {
    let command = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    let _ = std::process::Command::new(command)
        .arg(url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
}

/// The name to suggest on the approval page: a chosen hostname, then on a Mac the Computer Name
/// ("Sam's MacBook Pro") and the Bonjour name, then the hostname.
pub async fn default_machine_name() -> String {
    let mut names = Vec::new();
    if cfg!(target_os = "macos") {
        for key in ["HostName", "ComputerName", "LocalHostName"] {
            names.push(crate::sys::run("scutil", &["--get", key]).await);
        }
    }
    let host = crate::sys::run("hostname", &[]).await.unwrap_or_default();
    let host = host
        .strip_suffix(".local")
        .or_else(|| host.strip_suffix(".LOCAL"))
        .unwrap_or(&host)
        .to_string();
    names.push(Some(host));
    let name = names
        .into_iter()
        .flatten()
        .find(|n| !n.trim().is_empty())
        .unwrap_or_default();
    name.trim().chars().take(64).collect()
}
