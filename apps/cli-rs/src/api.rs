//! Calls to the gateway's HTTP API with the machine token, and the reasons they fail, as in
//! apps/cli/api-error.ts.

use crate::credentials::{self, Credentials};
use serde_json::Value;
use std::time::Duration;

pub enum Reply {
    Ok(Value),
    /// 401: the token is unknown or the machine was removed.
    Revoked,
    /// Any other status, with the body when it was JSON.
    Status(u16, Value),
    /// The request never got an answer.
    Unreachable(String),
}

pub fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(30)))
        .user_agent(crate::USER_AGENT.as_str())
        // The system's trust store, so a company proxy with its own root works as it does in a browser.
        .tls_config(
            ureq::tls::TlsConfig::builder()
                .root_certs(ureq::tls::RootCerts::PlatformVerifier)
                .build(),
        )
        .build()
        .into()
}

/// One request to `server` + `path`. `body` goes as JSON.
pub fn call(
    server: &str,
    method: &str,
    path: &str,
    bearer: Option<&str>,
    body: Option<&Value>,
) -> Reply {
    let url = format!("{}{path}", server.trim_end_matches('/'));
    let agent = agent();
    let mut request = ureq::http::Request::builder().method(method).uri(&url);
    if let Some(token) = bearer {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let result = match body {
        Some(body) => agent.run(
            request
                .header("content-type", "application/json")
                .body(body.to_string())
                .expect("valid request"),
        ),
        None => agent.run(request.body(()).expect("valid request")),
    };
    let mut response = match result {
        Ok(response) => response,
        Err(e) => return Reply::Unreachable(format!("couldn't reach {server} ({e})")),
    };
    let status = response.status().as_u16();
    let json = response
        .body_mut()
        .read_json::<Value>()
        .unwrap_or(Value::Null);
    match status {
        200..=299 => Reply::Ok(json),
        401 => Reply::Revoked,
        _ => Reply::Status(status, json),
    }
}

/// `call` with the saved token, and once more with the file's token when it was rejected and has
/// changed since: a running `connect` rotates it, so a copy read just before goes stale.
pub fn call_as_machine(
    credentials: &Credentials,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Reply {
    let first = call(
        &credentials.server,
        method,
        path,
        Some(&credentials.token),
        body,
    );
    if !matches!(first, Reply::Revoked) {
        return first;
    }
    match credentials::read() {
        Ok(Some(now))
            if now.token != credentials.token
                && now.machine.id == credentials.machine.id
                && now.server == credentials.server =>
        {
            call(&now.server, method, path, Some(&now.token), body)
        }
        _ => first,
    }
}

/// Why a request failed, for "Couldn't …: <reason>.": the API's message and code when it sent one
/// (@relayrunner/errors), otherwise the status.
pub fn failure_reason(server: &str, status: u16, body: &Value) -> String {
    let error = &body["error"];
    match (error["code"].as_str(), error["message"].as_str()) {
        (Some(code), Some(message)) => format!("{} ({code})", message.trim_end_matches('.')),
        _ => format!("{server} answered HTTP {status}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn describes_api_errors_and_bare_statuses() {
        let body = json!({ "error": { "code": "NOT_FOUND", "message": "Not found." } });
        assert_eq!(
            failure_reason("https://x", 404, &body),
            "Not found (NOT_FOUND)"
        );
        assert_eq!(
            failure_reason("https://x", 502, &Value::Null),
            "https://x answered HTTP 502"
        );
    }
}
