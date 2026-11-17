//! Tells someone at the terminal when npm has a newer relayrunner. It asks the npm registry at
//! most once a day and keeps the answer in <home>/update-check.json, so most runs read a file and
//! never touch the network. Any failure means no notice. A port of apps/cli/update-check.ts.

use serde::{Deserialize, Serialize};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
const REGISTRY_URL: &str = "https://registry.npmjs.org/relayrunner/latest";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Cache {
    checked_at: u64,
    latest: String,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// The newer version npm has, or None when this CLI is current or the check couldn't tell.
pub fn check() -> Option<String> {
    let path = crate::credentials::home().join("update-check.json");
    let cached: Option<Cache> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok());
    let now = now_ms();
    let cache = match cached {
        Some(c) if now.saturating_sub(c.checked_at) < CHECK_INTERVAL.as_millis() as u64 => c,
        stale => match fetch_latest() {
            Some(latest) => {
                let fresh = Cache {
                    checked_at: now,
                    latest,
                };
                // A cache we can't write only means asking npm again next time.
                let _ = std::fs::create_dir_all(crate::credentials::home());
                let _ = std::fs::write(
                    &path,
                    format!("{}\n", serde_json::to_string(&fresh).unwrap_or_default()),
                );
                fresh
            }
            None => stale?,
        },
    };
    crate::install::is_newer(&cache.latest, crate::VERSION).then_some(cache.latest)
}

fn fetch_latest() -> Option<String> {
    let mut response = crate::api::agent_with(Duration::from_secs(3), true)
        .get(REGISTRY_URL)
        .header("accept", "application/json")
        .call()
        .ok()?;
    let body: serde_json::Value = response.body_mut().read_json().ok()?;
    body["version"].as_str().map(str::to_string)
}

/// The line to print for a newer version, with the command that updates the way this one runs.
pub fn notice(latest: &str) -> String {
    // npx runs packages from its cache under .../_npx/<hash>/node_modules.
    let via_npx = std::env::current_exe()
        .map(|p| p.to_string_lossy().contains("/_npx/"))
        .unwrap_or(false);
    let command = if via_npx {
        "npx relayrunner@latest connect"
    } else {
        "npm install --global relayrunner@latest"
    };
    format!(
        "relayrunner {latest} is available (you have {}). Update with `{command}`.",
        crate::VERSION
    )
}
