//! Checks the JIT config in a `run` message before run.sh gets it. A port of
//! apps/cli/jit-config.ts: same rules, same reasons.

use base64::Engine;
use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use std::fmt;

const FILES: [&str; 3] = [".runner", ".credentials", ".credentials_rsaparams"];
const URL_FIELDS: [&str; 4] = ["serverurl", "serverurlv2", "githuburl", "authorizationurl"];

/// JSON that keeps every key of an object in order, duplicates included. serde_json's Value keeps
/// only the last of two equal keys, which would hide exactly what the duplicate check looks for.
#[derive(Debug)]
enum Json {
    Other,
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

impl<'de> Deserialize<'de> for Json {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Json;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("JSON")
            }
            fn visit_bool<E>(self, _: bool) -> Result<Json, E> {
                Ok(Json::Other)
            }
            fn visit_i64<E>(self, _: i64) -> Result<Json, E> {
                Ok(Json::Other)
            }
            fn visit_u64<E>(self, _: u64) -> Result<Json, E> {
                Ok(Json::Other)
            }
            fn visit_f64<E>(self, _: f64) -> Result<Json, E> {
                Ok(Json::Other)
            }
            fn visit_unit<E>(self) -> Result<Json, E> {
                Ok(Json::Other)
            }
            fn visit_str<E>(self, s: &str) -> Result<Json, E> {
                Ok(Json::Str(s.to_owned()))
            }
            fn visit_string<E>(self, s: String) -> Result<Json, E> {
                Ok(Json::Str(s))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Json, A::Error> {
                let mut items = Vec::new();
                while let Some(item) = seq.next_element()? {
                    items.push(item);
                }
                Ok(Json::Arr(items))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Json, A::Error> {
                let mut entries = Vec::new();
                while let Some(entry) = map.next_entry()? {
                    entries.push(entry);
                }
                Ok(Json::Obj(entries))
            }
        }
        d.deserialize_any(V)
    }
}

fn decode_json(b64: &str) -> Option<Json> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .ok()?;
    let text = String::from_utf8(bytes).ok()?;
    serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()
}

/// Ok with what the runner is registered on (owner/repo or owner), or the reason it's refused.
pub fn check(encoded: &str, route_id: &str) -> Result<Option<String>, String> {
    let Some(Json::Obj(files)) = decode_json(encoded) else {
        return Err("it isn't a runner config".into());
    };
    let names: Vec<&str> = files.iter().map(|(k, _)| k.as_str()).collect();
    if names.len() != FILES.len() || !FILES.iter().all(|f| names.contains(f)) {
        let held = if names.is_empty() {
            "nothing".to_string()
        } else {
            names.join(", ")
        };
        return Err(format!("it holds {held}, not GitHub's files"));
    }

    let mut decoded = Vec::new();
    for (name, value) in files {
        let Json::Str(text) = value else {
            return Err(format!("{name} isn't a file"));
        };
        let Some(json) = decode_json(&text) else {
            return Err(format!("{name} isn't JSON"));
        };
        decoded.push((name, json));
    }
    let Some((_, Json::Obj(runner))) = decoded.iter().find(|(n, _)| n == ".runner") else {
        return Err("it has no .runner".into());
    };
    for (_, json) in &decoded {
        if let Some(dup) = duplicate_key(json) {
            return Err(format!("it has {dup} twice"));
        }
    }

    let mut found = Vec::new();
    for (_, json) in &decoded {
        urls(json, "", &mut found);
    }
    for text in found {
        let Ok(parsed) = url::Url::parse(&text) else {
            return Err(format!("it names a URL that doesn't parse: {text}"));
        };
        let host = parsed.host_str().unwrap_or("");
        let github = host == "github.com"
            || host.ends_with(".github.com")
            || host.ends_with(".githubusercontent.com");
        if parsed.scheme() != "https" || !github {
            return Err(format!(
                "it points the runner at {}, not GitHub",
                parsed.origin().ascii_serialization()
            ));
        }
    }

    let field = |key: &str| {
        runner
            .iter()
            .find(|(n, _)| n.to_lowercase() == key)
            .and_then(|(_, v)| match v {
                Json::Str(s) => Some(s.as_str()),
                _ => None,
            })
    };
    if field("serverurl").is_none() && field("serverurlv2").is_none() {
        return Err("it doesn't say which GitHub server to use".into());
    }
    match field("agentname") {
        Some(name) if name.ends_with(&format!("-{route_id}")) => {}
        name => {
            return Err(format!(
                "its runner {} isn't for job {route_id}",
                name.unwrap_or("(no name)")
            ));
        }
    }
    Ok(field("githuburl").and_then(target))
}

fn target(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    let parts: Vec<&str> = parsed
        .path_segments()?
        .filter(|s| !s.is_empty())
        .take(2)
        .collect();
    (!parts.is_empty()).then(|| parts.join("/"))
}

fn urls(value: &Json, key: &str, found: &mut Vec<String>) {
    match value {
        Json::Str(s) => {
            let text = s.trim();
            if !text.is_empty()
                && (URL_FIELDS.contains(&key.to_lowercase().as_str()) || has_scheme(text))
            {
                found.push(text.to_owned());
            }
        }
        Json::Arr(items) => items.iter().for_each(|i| urls(i, "", found)),
        Json::Obj(entries) => entries.iter().for_each(|(k, v)| urls(v, k, found)),
        Json::Other => {}
    }
}

// /^[a-z][a-z0-9+.-]*:/i
fn has_scheme(text: &str) -> bool {
    let mut chars = text.chars();
    if !chars.next().is_some_and(|c| c.is_ascii_alphabetic()) {
        return false;
    }
    for c in chars {
        if c == ':' {
            return true;
        }
        if !(c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-')) {
            return false;
        }
    }
    false
}

fn duplicate_key(value: &Json) -> Option<String> {
    match value {
        Json::Arr(items) => items.iter().find_map(duplicate_key),
        Json::Obj(entries) => {
            let mut seen = std::collections::HashSet::new();
            for (name, item) in entries {
                if !seen.insert(name.to_lowercase()) {
                    return Some(name.clone());
                }
                if let Some(dup) = duplicate_key(item) {
                    return Some(dup);
                }
            }
            None
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64(s: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(s)
    }

    fn config(runner: &str) -> String {
        b64(&format!(
            r#"{{".runner":"{}",".credentials":"{}",".credentials_rsaparams":"{}"}}"#,
            b64(runner),
            b64(
                r#"{"scheme":"OAuth","data":{"authorizationUrl":"https://vstoken.actions.githubusercontent.com/x"}}"#
            ),
            b64(r#"{"d":"x"}"#),
        ))
    }

    const GOOD: &str = r#"{"agentName":"mac-r1","serverUrl":"https://pipelines.actions.githubusercontent.com/abc","gitHubUrl":"https://github.com/acme/app"}"#;

    #[test]
    fn accepts_githubs_config() {
        assert_eq!(check(&config(GOOD), "r1"), Ok(Some("acme/app".into())));
    }

    #[test]
    fn refuses_other_servers_routes_and_duplicates() {
        let evil = GOOD.replace("pipelines.actions.githubusercontent.com", "evil.example");
        assert_eq!(
            check(&config(&evil), "r1"),
            Err("it points the runner at https://evil.example, not GitHub".into())
        );
        assert!(
            check(&config(GOOD), "r2")
                .unwrap_err()
                .contains("isn't for job r2")
        );
        let dup = GOOD.replace(
            r#""agentName""#,
            r#""serverurl":"https://github.com","ServerUrl""#,
        );
        assert!(check(&config(&dup), "r1").unwrap_err().contains("twice"));
        assert_eq!(
            check(&b64("[]"), "r1"),
            Err("it isn't a runner config".into())
        );
    }

    #[test]
    fn reads_backslash_urls_the_way_the_runner_does() {
        let sneaky = GOOD.replace(
            "https://pipelines.actions.githubusercontent.com/abc",
            r"https:\\\\evil.example\\\\abc",
        );
        assert!(
            check(&config(&sneaky), "r1")
                .unwrap_err()
                .contains("evil.example")
        );
    }
}
