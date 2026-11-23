//! `relayrunner feedback`: sends a message to the RelayRunner team with the machine's own token
//! (POST /api/machines/me/feedback). RelayRunner for Mac sends crash reports through it, after
//! showing the person what's in them.

use crate::api::{self, Reply};
use crate::credentials::Credentials;
use crate::error::Error;
use serde_json::json;

struct Args {
    message: String,
    category: String,
}

fn parse(args: &[String]) -> Result<Args, Error> {
    let usage = |m: String| Error::new("USAGE", m);
    let mut message = None;
    let mut category = "other".to_string();
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        let (flag, inline) = match arg.split_once('=') {
            Some((flag, value)) if flag.starts_with("--") => (flag, Some(value.to_string())),
            _ => (arg.as_str(), None),
        };
        let mut value = |name: &str| {
            inline
                .clone()
                .or_else(|| it.next().cloned())
                .ok_or_else(|| usage(format!("{name} needs a value.")))
        };
        match flag {
            // The gateway checks it, so a category added there works without a new CLI.
            "--category" => category = value("--category")?,
            "--file" => {
                let path = value("--file")?;
                let text = std::fs::read_to_string(&path)
                    .map_err(|e| usage(format!("Couldn't read {path}: {e}.")))?;
                message = Some(text);
            }
            _ if flag.starts_with('-') => {
                return Err(usage(format!(
                    "Unknown option {arg}. See `relayrunner feedback --help`."
                )));
            }
            _ if message.is_none() => message = Some(arg.clone()),
            _ => {
                return Err(usage(
                    "Put the message in quotes, or pass --file.".to_string(),
                ));
            }
        }
    }
    let message = message
        .filter(|m| !m.trim().is_empty())
        .ok_or_else(|| usage("Say what to send: relayrunner feedback \"…\"".to_string()))?;
    Ok(Args { message, category })
}

pub fn command(credentials: &Credentials, args: &[String]) -> Result<(), Error> {
    let Args { message, category } = parse(args)?;
    let server = &credentials.server;
    let body = json!({ "message": message, "category": category });
    let failed =
        |reason: String| Error::new("FEEDBACK_FAILED", format!("Couldn't send it: {reason}."));
    match api::call_as_machine(
        credentials,
        "POST",
        "/api/machines/me/feedback",
        Some(&body),
    ) {
        Reply::Ok(_) => {
            println!("Sent. Thanks for telling us.");
            Ok(())
        }
        Reply::Revoked => Err(crate::share::revoked(&credentials.machine.name)),
        Reply::Status(status, body) => Err(failed(api::failure_reason(server, status, &body))),
        Reply::Unreachable(reason) => Err(failed(reason)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn reads_a_message_or_a_file() {
        let parsed = parse(&args(&["it broke"])).unwrap();
        assert_eq!(
            (parsed.message.as_str(), parsed.category.as_str()),
            ("it broke", "other")
        );

        let path = std::env::temp_dir().join(format!("rr-feedback-{}.txt", std::process::id()));
        std::fs::write(&path, "crashed\n\nframes").unwrap();
        let parsed = parse(&args(&["--category=bug", "--file", path.to_str().unwrap()])).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert_eq!(parsed.message, "crashed\n\nframes");
        assert_eq!(parsed.category, "bug");
    }

    #[test]
    fn refuses_bad_input() {
        for bad in [&[][..], &["  "], &["--bogus"], &["one", "two"], &["--file"]] {
            assert_eq!(
                parse(&args(bad)).err().map(|e| e.code),
                Some("USAGE"),
                "{bad:?}"
            );
        }
    }
}
