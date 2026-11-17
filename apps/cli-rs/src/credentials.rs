//! ~/.relayrunner/machine.json, shared with older (TypeScript) versions.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::PathBuf;

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Machine {
    pub id: String,
    pub name: String,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Credentials {
    pub server: String,
    pub machine: Machine,
    pub token: String,
}

pub fn home() -> PathBuf {
    match std::env::var_os("RELAYRUNNER_HOME").filter(|h| !h.is_empty()) {
        Some(home) => PathBuf::from(home),
        None => PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".relayrunner"),
    }
}

fn path() -> PathBuf {
    home().join("machine.json")
}

fn sends_token_safely(server: &str) -> bool {
    let Ok(url) = url::Url::parse(server) else {
        return false;
    };
    let loopback = match url.host() {
        Some(url::Host::Domain(d)) => d == "localhost",
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    };
    url.scheme() == "https" || (url.scheme() == "http" && loopback)
}

/// The stored credentials, or None when there are none or they don't read.
pub fn read() -> std::io::Result<Option<Credentials>> {
    let text = match std::fs::read_to_string(path()) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    Ok(serde_json::from_str::<Credentials>(&text).ok().filter(|c| {
        !c.machine.id.is_empty() && !c.token.is_empty() && sends_token_safely(&c.server)
    }))
}

/// Saves a new sign-in in place of whatever was there.
pub fn save(credentials: &Credentials) -> std::io::Result<()> {
    write(&serde_json::to_value(credentials)?)
}

pub fn delete() {
    let _ = std::fs::remove_file(path());
}

pub fn path_display() -> String {
    path().display().to_string()
}

/// The URL's origin, or a USAGE error for anything but https, or http to this computer.
pub fn normalize_server(value: &str) -> Result<String, crate::error::Error> {
    let usage = |m: String| crate::error::Error::new("USAGE", m);
    let url = url::Url::parse(value)
        .ok()
        .filter(|u| matches!(u.scheme(), "https" | "http"))
        .ok_or_else(|| usage(format!("Not a valid RelayRunner URL: {value}")))?;
    let origin = url.origin().ascii_serialization();
    if !sends_token_safely(&origin) {
        return Err(usage(format!(
            "{origin} isn't https. RelayRunner only uses plain http for localhost, since the machine token is sent on every connect."
        )));
    }
    Ok(origin)
}

/// Saves a token the gateway rotated, keeping the rest of the file as it is. Fails, saving
/// nothing, when the file now holds another sign-in or is gone.
pub fn save_rotated_token(was: &Credentials, token: &str) -> Result<(), String> {
    let text = match std::fs::read_to_string(path()) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err("machine.json was removed".into());
        }
        result => result.map_err(|e| e.to_string())?,
    };
    let mut value: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    if value["machine"]["id"] != was.machine.id.as_str() || value["server"] != was.server.as_str() {
        return Err("machine.json now holds another sign-in".into());
    }
    value["token"] = token.into();
    write(&value).map_err(|e| e.to_string())
}

// 0600 in a temp file, then renamed, so a crash never leaves half a token.
fn write(value: &Value) -> std::io::Result<()> {
    let path = path();
    let temp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&temp)?;
    file.write_all(format!("{}\n", serde_json::to_string_pretty(value)?).as_bytes())?;
    std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600))?;
    std::fs::rename(temp, path)
}
