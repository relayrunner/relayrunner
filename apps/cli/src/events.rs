//! `connect --events`: for an app that runs `connect` on someone's behalf, such as the Mac menu bar
//! app.
//!
//! stdout carries one JSON object per line and nothing else: everything `connect` would print for
//! a person, job output included, goes to stderr instead. Each object has `v` (this format's
//! version), `at` (an ISO time) and `type`: `sign-in` (the page to approve this machine on and its
//! code), `machine` (once signed in), what the connection reports (`connecting`, `connected`,
//! `run`, `job`, `paused` and so on), `state` (the machine's state after each of those),
//! `job-repo`, `offline` and `error`. stdin takes one command per line: `pause` or `resume`.
//!
//! To go offline the way Ctrl-C does, start `connect` in its own process group and send that group
//! SIGINT (a second one exits on the spot). Closing stdin goes offline too, for when the app quits
//! or crashes, and lets a running job finish.

use serde_json::{Value, json};
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static ON: AtomicBool = AtomicBool::new(false);

pub fn start() {
    ON.store(true, Ordering::Relaxed);
}

pub fn on() -> bool {
    ON.load(Ordering::Relaxed)
}

/// Writes `{v, at, type, ...fields}` to stdout when events are on.
pub fn emit(kind: &str, fields: Value) {
    if !on() {
        return;
    }
    let mut event = json!({ "v": 1, "at": now_iso(), "type": kind });
    if let (Some(event), Value::Object(fields)) = (event.as_object_mut(), fields) {
        event.extend(fields);
    }
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{event}");
    let _ = out.flush();
}

/// A line for a person, as clack's log.info: stderr when stdout carries events, stdout otherwise.
pub fn log(line: &str) {
    crate::ui::info(line);
}

/// The time as JavaScript's toISOString writes it: 2026-11-16T22:28:36.123Z.
pub fn now_iso() -> String {
    let since = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = since.as_secs() as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60,
        since.subsec_millis()
    )
}

/// The local time of day, such as 14:03:09, for log lines.
pub fn local_time() -> String {
    // SAFETY: localtime_r writes only into the struct we pass.
    unsafe {
        let now = libc::time(std::ptr::null_mut());
        let mut tm: libc::tm = std::mem::zeroed();
        libc::localtime_r(&now, &mut tm);
        format!("{:02}:{:02}:{:02}", tm.tm_hour, tm.tm_min, tm.tm_sec)
    }
}
