//! `relayrunner whoami`: asks the gateway who the saved machine token belongs to
//! (GET /api/machines/me). Only reads: a revoked token is reported, not deleted, since the next
//! `connect` replaces it.

use crate::api::{self, Reply};
use crate::credentials::{self, Credentials};
use crate::error::Error;
use crate::login::{self, Workspace};
use crate::share::Share;
use serde_json::{Value, json};

pub enum Identity {
    Ok(Value),
    Revoked,
    /// The gateway couldn't be reached or answered with something unexpected.
    Unverified(String),
}

pub fn fetch(credentials: &Credentials) -> Identity {
    let server = &credentials.server;
    match api::call_as_machine(credentials, "GET", "/api/machines/me", None) {
        Reply::Ok(body)
            if body["machine"]["id"]
                .as_str()
                .is_some_and(|id| !id.is_empty()) =>
        {
            Identity::Ok(body)
        }
        Reply::Ok(_) => Identity::Unverified(format!("{server} sent an unexpected response")),
        Reply::Revoked => Identity::Revoked,
        Reply::Status(status, body) => {
            Identity::Unverified(api::failure_reason(server, status, &body))
        }
        Reply::Unreachable(reason) => Identity::Unverified(reason),
    }
}

pub fn names(workspaces: &[Workspace]) -> String {
    crate::workspaces::join_names(workspaces.iter().map(|w| w.name.as_str()).collect())
}

/// What "anyone" reaches: the one workspace by name, or "your workspaces".
pub fn scope(workspaces: &[Workspace]) -> String {
    match workspaces {
        [one] => one.name.clone(),
        _ => "your workspaces".into(),
    }
}

/// Whether anyone else is in one of them, so teammates' jobs could run on the machine.
pub fn has_teammates(workspaces: &[Workspace]) -> bool {
    workspaces.iter().any(|w| w.member_count.unwrap_or(0) > 1)
}

pub fn command(args: &[String]) -> Result<i32, Error> {
    let mut json_out = false;
    let mut requested = None;
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.split_once('=') {
            Some(("--server", v)) => requested = Some(v.to_string()),
            _ if arg == "--server" => {
                requested = Some(
                    it.next()
                        .cloned()
                        .ok_or_else(|| Error::new("USAGE", "--server needs a value."))?,
                );
            }
            _ if arg == "--json" => json_out = true,
            _ => {
                return Err(Error::new(
                    "USAGE",
                    format!("Unknown option {arg}. See `relayrunner whoami --help`."),
                ));
            }
        }
    }
    let print = |human: &str, json: Value| {
        if json_out {
            println!(
                "{}",
                serde_json::to_string_pretty(&json).expect("serializes")
            );
        } else {
            println!("{human}");
        }
    };

    let saved =
        credentials::read().map_err(|e| Error::new("CREDENTIALS_UNREADABLE", e.to_string()))?;
    let requested = requested
        .or_else(|| std::env::var("RELAYRUNNER_URL").ok())
        .filter(|s| !s.is_empty());
    let server = match &requested {
        Some(r) => Some(credentials::normalize_server(r)?),
        None => saved.as_ref().map(|c| c.server.clone()),
    };
    let credentials = match saved {
        Some(c) if Some(&c.server) == server.as_ref() => c,
        other => {
            let human = match &other {
                Some(c) => format!(
                    "Not signed in to {}. This machine is enrolled with {}.",
                    server.clone().unwrap_or_default(),
                    c.server
                ),
                None => {
                    "Not signed in. Run `relayrunner login` or `relayrunner connect` to sign in."
                        .into()
                }
            };
            print(&human, json!({ "status": "signed_out", "server": server }));
            return Ok(1);
        }
    };

    let saved_json = json!({
        "server": credentials.server,
        "machine": { "id": credentials.machine.id, "name": credentials.machine.name },
    });
    match fetch(&credentials) {
        Identity::Ok(identity) => {
            let workspaces = login::read_workspaces(&identity);
            let notice = (!json_out && workspaces.is_empty())
                .then(|| crate::workspaces::empty_notice(&credentials));
            let mut out = json!({ "status": "ok", "server": credentials.server });
            merge(&mut out, &identity);
            print(
                &describe(&credentials.server, &identity, notice.as_deref()),
                out,
            );
            Ok(0)
        }
        Identity::Revoked => {
            let mut out = json!({ "status": "revoked" });
            merge(&mut out, &saved_json);
            print(
                &format!(
                    "{} was removed or its token is no longer valid.\nRun `relayrunner connect` to sign in again.",
                    credentials.machine.name
                ),
                out,
            );
            Ok(1)
        }
        Identity::Unverified(reason) => {
            let mut out = json!({ "status": "unverified", "reason": reason });
            merge(&mut out, &saved_json);
            let saved = table(
                &format!("{} ({})", credentials.machine.name, credentials.machine.id),
                &[("Gateway", credentials.server.clone())],
            );
            print(
                &format!(
                    "{saved}\n\nUnverified: {reason}. This is what's saved in {}.",
                    credentials::path_display()
                ),
                out,
            );
            Ok(0)
        }
    }
}

fn merge(into: &mut Value, from: &Value) {
    if let (Some(into), Some(from)) = (into.as_object_mut(), from.as_object()) {
        into.extend(from.clone());
    }
}

fn describe(server: &str, identity: &Value, notice: Option<&str>) -> String {
    let machine = &identity["machine"];
    let workspaces = login::read_workspaces(identity);
    let text = |v: &Value| v.as_str().unwrap_or_default().to_string();
    let mut status = if machine["status"]["online"] == true {
        match machine["status"]["state"].as_str() {
            Some(state) => format!("online, {state}"),
            None => "online".into(),
        }
    } else {
        "offline".into()
    };
    if machine["paused"].is_object() {
        status.push_str(", paused");
        if let Some(by) = machine["paused"]["by"].as_str() {
            status.push_str(&format!(" by {by}"));
        }
    }
    let by = &identity["enrolledBy"];
    let mut enrolled = Vec::new();
    if by.is_object() {
        enrolled.push(format!("by {} <{}>", text(&by["name"]), text(&by["email"])));
    }
    if let Some(date) = local_date(&machine["createdAt"]) {
        enrolled.push(format!("on {date}"));
    }
    let platform = [text(&machine["os"]), text(&machine["arch"])]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let mut rows = vec![
        (
            "Workspaces",
            if workspaces.is_empty() {
                "none".to_string()
            } else {
                names(&workspaces)
            },
        ),
        (
            "Platform",
            if platform.is_empty() {
                "unknown".into()
            } else {
                platform
            },
        ),
        ("Enrolled", enrolled.join(" ")),
        ("Status", status),
    ];
    if let Some(share) = machine["sharing"].as_str().and_then(Share::from_sharing) {
        rows.push(("Sharing", share.summary(&scope(&workspaces))));
    }
    rows.push(("Gateway", server.to_string()));
    let details = table(
        &format!("{} ({})", text(&machine["name"]), text(&machine["id"])),
        &rows,
    );
    match notice {
        Some(notice) => format!("{details}\n\n{notice}"),
        None => details,
    }
}

fn table(title: &str, rows: &[(&str, String)]) -> String {
    let width = rows.iter().map(|(l, _)| l.len()).max().unwrap_or(0);
    let mut lines = vec![title.to_string()];
    lines.extend(
        rows.iter()
            .map(|(label, value)| format!("  {label:<width$}  {value}")),
    );
    lines.join("\n")
}

/// A date the API sent (ISO text or milliseconds) as a local date, such as 11/16/2026.
fn local_date(value: &Value) -> Option<String> {
    let secs = match value {
        Value::Number(n) => n.as_f64()? as i64 / 1000,
        Value::String(s) => iso_seconds(s)?,
        _ => return None,
    };
    // SAFETY: localtime_r writes only into the struct we pass.
    unsafe {
        // libc marks time_t deprecated on musl while it widens it; the cast is right either way.
        #[allow(deprecated)]
        let t = secs as libc::time_t;
        let mut tm: libc::tm = std::mem::zeroed();
        libc::localtime_r(&t, &mut tm);
        Some(format!(
            "{}/{}/{}",
            tm.tm_mon + 1,
            tm.tm_mday,
            tm.tm_year + 1900
        ))
    }
}

/// Seconds since 1970 for "2026-11-16T22:28:36.123Z" (UTC).
fn iso_seconds(text: &str) -> Option<i64> {
    let num = |range: std::ops::Range<usize>| text.get(range)?.parse::<i64>().ok();
    let (y, m, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (hh, mm, ss) = if text.len() >= 19 {
        (num(11..13)?, num(14..16)?, num(17..19)?)
    } else {
        (0, 0, 0)
    };
    // Howard Hinnant's days_from_civil.
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + hh * 3600 + mm * 60 + ss)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_iso_times() {
        assert_eq!(iso_seconds("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(iso_seconds("2026-11-16T22:28:36.123Z"), Some(1_794_868_116));
        assert_eq!(iso_seconds("2024-02-29"), Some(1_709_164_800));
    }

    #[test]
    fn describes_a_machine() {
        let identity = json!({
            "machine": {
                "id": "m_1", "name": "box", "os": "macos", "arch": "arm64",
                "createdAt": "2026-11-16T12:00:00.000Z", "lastSeenAt": null,
                "status": { "online": true, "state": "idle" },
                "paused": { "by": "Pat" }, "sharing": "anyone",
            },
            "workspaces": [{ "id": "ws_1", "name": "Acme", "memberCount": 2 }],
            "enrolledBy": { "name": "Pat", "email": "pat@example.com" },
        });
        let text = describe("https://app.example", &identity, None);
        assert!(text.starts_with("box (m_1)\n  Workspaces  Acme\n  Platform    macos arm64\n"));
        assert!(text.contains("  Status      online, idle, paused by Pat\n"));
        assert!(text.contains(
            "  Sharing     anyone (shared runner): runs any job in Acme, including teammates' and bots'\n"
        ));
        assert!(text.ends_with("  Gateway     https://app.example"));
    }
}
