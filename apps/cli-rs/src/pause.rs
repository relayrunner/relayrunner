//! `relayrunner pause` and `resume`: stop or start routing jobs to this machine
//! (POST /api/machines/me/pause|resume). The machine stays connected either way.

use crate::api::{self, Reply};
use crate::credentials::Credentials;
use crate::error::Error;

pub enum Outcome {
    /// `busy`: the machine is running a job, which it finishes first.
    Ok {
        busy: bool,
    },
    Revoked,
    Failed(String),
}

pub fn set(credentials: &Credentials, paused: bool) -> Outcome {
    let server = &credentials.server;
    let action = if paused { "pause" } else { "resume" };
    match api::call_as_machine(
        credentials,
        "POST",
        &format!("/api/machines/me/{action}"),
        None,
    ) {
        Reply::Ok(body) if body["machine"].is_object() => Outcome::Ok {
            busy: body["machine"]["status"]["state"] == "busy",
        },
        Reply::Ok(_) => Outcome::Failed(format!("{server} sent an unexpected response")),
        Reply::Revoked => Outcome::Revoked,
        Reply::Status(status, body) => Outcome::Failed(api::failure_reason(server, status, &body)),
        Reply::Unreachable(reason) => Outcome::Failed(reason),
    }
}

pub fn command(credentials: &Credentials, paused: bool) -> Result<(), Error> {
    let name = &credentials.machine.name;
    match set(credentials, paused) {
        Outcome::Ok { busy } if paused => {
            let busy = if busy {
                "\nIt finishes the job it's running first."
            } else {
                ""
            };
            println!(
                "Paused {name}. It stays connected, and new jobs will skip it.{busy}\nRun `relayrunner resume` to take jobs again."
            );
            Ok(())
        }
        Outcome::Ok { .. } => {
            println!("Resumed {name}. Jobs can route here again.");
            Ok(())
        }
        Outcome::Revoked => Err(crate::share::revoked(name)),
        Outcome::Failed(reason) => Err(Error::new(
            "PAUSE_FAILED",
            format!(
                "Couldn't {} {name}: {reason}.",
                if paused { "pause" } else { "resume" }
            ),
        )),
    }
}
