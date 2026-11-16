//! ~/.relayrunner/machine.json, shared with the TypeScript CLI. A port of apps/cli/credentials.ts.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::PathBuf;

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Machine {
    pub id: String,
    pub name: String,
}

#[derive(Deserialize, Clone, Debug)]
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
    url.scheme() == "https"
        || (url.scheme() == "http"
            && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")))
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

/// Saves a token the gateway rotated, keeping the rest of the file as it is. Fails, saving
/// nothing, when the file now holds another sign-in or is gone.
pub fn save_rotated_token(was: &Credentials, token: &str) -> Result<(), String> {
    let now = read()
        .map_err(|e| e.to_string())?
        .ok_or("machine.json was removed")?;
    if now.machine.id != was.machine.id || now.server != was.server {
        return Err("machine.json now holds another sign-in".into());
    }
    let text = std::fs::read_to_string(path()).map_err(|e| e.to_string())?;
    let mut value: Map<String, Value> = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    value.insert("token".into(), token.into());
    write(&Value::Object(value)).map_err(|e| e.to_string())
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
