//! Who can run jobs on this machine: `relayrunner share`, `connect --share`. The CLI says only-me
//! and anyone; the gateway stores only_me and anyone.

use crate::api::{self, Reply};
use crate::credentials::Credentials;
use crate::error::Error;
use serde_json::json;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Share {
    OnlyMe,
    Anyone,
}

impl Share {
    pub fn parse(value: &str) -> Option<Share> {
        match value {
            "only-me" => Some(Share::OnlyMe),
            "anyone" => Some(Share::Anyone),
            _ => None,
        }
    }

    pub fn from_sharing(value: &str) -> Option<Share> {
        match value {
            "only_me" => Some(Share::OnlyMe),
            "anyone" => Some(Share::Anyone),
            _ => None,
        }
    }

    fn sharing(self) -> &'static str {
        match self {
            Share::OnlyMe => "only_me",
            Share::Anyone => "anyone",
        }
    }

    pub fn choice(self) -> &'static str {
        match self {
            Share::OnlyMe => "only-me",
            Share::Anyone => "anyone",
        }
    }

    /// What it means, as in "<machine> runs only jobs you started".
    pub fn meaning(self, scope: &str) -> String {
        match self {
            Share::OnlyMe => "runs only jobs you started".into(),
            Share::Anyone => format!("runs any job in {scope}, including teammates' and bots'"),
        }
    }
}

/// `--share` as given, or a USAGE error.
pub fn arg(value: Option<&str>) -> Result<Option<Share>, Error> {
    match value {
        None | Some("") => Ok(None),
        Some(value) => Share::parse(value).map(Some).ok_or_else(|| {
            Error::new(
                "USAGE",
                format!("--share takes only-me or anyone, not {value:?}."),
            )
        }),
    }
}

pub enum Outcome {
    Ok(Share),
    Revoked,
    Failed(String),
}

/// PUT /api/machines/me/sharing.
pub fn set(credentials: &Credentials, share: Share) -> Outcome {
    let server = &credentials.server;
    match api::call_as_machine(
        credentials,
        "PUT",
        "/api/machines/me/sharing",
        Some(&json!({ "sharing": share.sharing() })),
    ) {
        Reply::Ok(body) => match body["machine"]["sharing"]
            .as_str()
            .and_then(Share::from_sharing)
        {
            Some(now) => Outcome::Ok(now),
            None => Outcome::Failed(format!("{server} sent an unexpected response")),
        },
        Reply::Revoked => Outcome::Revoked,
        Reply::Status(404 | 405, _) => {
            Outcome::Failed(format!("{server} doesn't support sharing yet"))
        }
        Reply::Status(status, body) => Outcome::Failed(api::failure_reason(server, status, &body)),
        Reply::Unreachable(reason) => Outcome::Failed(reason),
    }
}

/// `relayrunner share [only-me|anyone]`: shows the setting, or changes it.
pub fn command(credentials: &Credentials, value: Option<&str>) -> Result<(), Error> {
    let name = &credentials.machine.name;
    let Some(value) = value else {
        return show(credentials);
    };
    let share = Share::parse(value).ok_or_else(|| {
        Error::new(
            "USAGE",
            "Use `relayrunner share only-me` or `relayrunner share anyone`.",
        )
    })?;
    match set(credentials, share) {
        Outcome::Ok(now) => {
            println!("{name} now {}.", now.meaning("your workspaces"));
            Ok(())
        }
        Outcome::Revoked => Err(revoked(name)),
        Outcome::Failed(reason) => Err(Error::new(
            "SHARE_FAILED",
            format!("Couldn't change sharing for {name}: {reason}."),
        )),
    }
}

fn show(credentials: &Credentials) -> Result<(), Error> {
    use crate::whoami::{self, Identity};
    let name = &credentials.machine.name;
    let identity = match whoami::fetch(credentials) {
        Identity::Ok(identity) => identity,
        Identity::Revoked => return Err(revoked(name)),
        Identity::Unverified(reason) => {
            return Err(Error::new(
                "SHARE_FAILED",
                format!("Couldn't check sharing for {name}: {reason}."),
            ));
        }
    };
    let Some(share) = identity["machine"]["sharing"]
        .as_str()
        .and_then(Share::from_sharing)
    else {
        return Err(Error::new(
            "SHARE_UNSUPPORTED",
            format!("{} doesn't support sharing yet.", credentials.server),
        ));
    };
    let workspaces = crate::login::read_workspaces(&identity);
    let scope = whoami::scope(&workspaces);
    let other = match share {
        Share::OnlyMe => "anyone",
        Share::Anyone => "only-me",
    };
    println!("{name} {} ({}).", share.meaning(&scope), share.choice());
    if workspaces.is_empty() {
        println!("{name} isn't in a workspace yet, so this matters once it is.");
    } else if workspaces.iter().all(|w| w.member_count == Some(1)) {
        println!("Nobody else is in {scope} yet, so this matters once a teammate joins.");
    }
    println!("Change it with `relayrunner share {other}`.");
    Ok(())
}

pub fn revoked(name: &str) -> Error {
    Error::new(
        "REVOKED",
        format!(
            "{name} was removed or its token is no longer valid.\nRun `relayrunner connect` to sign in again."
        ),
    )
}
