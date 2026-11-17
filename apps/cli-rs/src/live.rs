//! What a running `connect` shows outside its log: the terminal tab's title, kept to the
//! machine's live state, and the keys it answers to (`p` pauses or resumes). A port of
//! apps/cli/live.ts.

use std::io::{IsTerminal, Read, Write};
use std::sync::Mutex;

const SAVE_TITLE: &str = "\x1b[22;0t";
const RESTORE_TITLE: &str = "\x1b[23;0t";

struct Live {
    machine: String,
    title: bool,
    keys: bool,
    /// Whether it has come online yet, for the one-time key hint.
    online_once: bool,
    paused: bool,
    shown: String,
    /// The terminal settings to put back.
    termios: Option<libc::termios>,
}

static LIVE: Mutex<Option<Live>> = Mutex::new(None);

/// The title for a state, such as "RelayRunner · M3P0 · Waiting for jobs".
pub fn title_for(machine: &str, link: &str, paused: bool, jobs: usize) -> String {
    let running = if jobs == 1 {
        "Running a job".to_string()
    } else {
        format!("Running {jobs} jobs")
    };
    let status = match link {
        "connecting" => "Connecting…".to_string(),
        "reconnecting" if jobs > 0 => format!("{running}, reconnecting…"),
        "reconnecting" => "Reconnecting…".to_string(),
        _ if jobs > 0 && paused => format!("{running}, then paused"),
        _ if jobs > 0 => running,
        _ if paused => "Paused".to_string(),
        _ => "Waiting for jobs".to_string(),
    };
    format!("RelayRunner · {machine} · {status}")
}

fn title_sequence(title: &str) -> String {
    let clean: String = title.chars().filter(|c| !c.is_control()).collect();
    format!("\x1b]0;{clean}\x07")
}

fn write_out(text: &str) {
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(text.as_bytes());
    let _ = out.flush();
}

/// Starts the title (when stdout is a terminal) and the keys (when stdin is one too, and stdout
/// doesn't carry events). `toggle` gets whether the machine is paused now, when `p` is pressed.
pub fn start(machine: &str, toggle: impl Fn(bool) + Send + 'static) {
    let events = crate::events::on();
    let title = !events && std::io::stdout().is_terminal();
    let keys = title && std::io::stdin().is_terminal();
    let shown = title_for(machine, "connecting", false, 0);
    if title {
        write_out(&format!("{SAVE_TITLE}{}", title_sequence(&shown)));
    }
    let termios = if keys { raw_keys() } else { None };
    *LIVE.lock().unwrap() = Some(Live {
        machine: machine.to_string(),
        title,
        keys: termios.is_some(),
        online_once: false,
        paused: false,
        shown,
        termios,
    });
    if termios.is_some() {
        std::thread::spawn(move || {
            let mut stdin = std::io::stdin().lock();
            let mut byte = [0u8; 1];
            while stdin.read(&mut byte).unwrap_or(0) == 1 {
                match byte[0] {
                    b'p' | b'P' => {
                        let paused = LIVE.lock().unwrap().as_ref().is_some_and(|l| l.paused);
                        toggle(paused);
                    }
                    // Ctrl-C, which the terminal no longer turns into SIGINT: to the whole
                    // process group, as the terminal would, so a job's runner hears it too.
                    3 => unsafe {
                        // SAFETY: kill only sends a signal.
                        libc::kill(0, libc::SIGINT);
                    },
                    _ => {}
                }
            }
        });
    }
}

/// Keys one at a time, unechoed, with Ctrl-C as a key. The old settings, to put back.
fn raw_keys() -> Option<libc::termios> {
    // SAFETY: tcgetattr and tcsetattr only read and write the struct we pass.
    unsafe {
        let mut was: libc::termios = std::mem::zeroed();
        if libc::tcgetattr(0, &mut was) != 0 {
            return None;
        }
        let mut raw = was;
        raw.c_lflag &= !(libc::ICANON | libc::ECHO | libc::ISIG);
        raw.c_cc[libc::VMIN] = 1;
        raw.c_cc[libc::VTIME] = 0;
        (libc::tcsetattr(0, libc::TCSANOW, &raw) == 0).then_some(was)
    }
}

/// Whether `p` works, for the "Press p to resume" hint.
pub fn keys() -> bool {
    LIVE.lock().unwrap().as_ref().is_some_and(|l| l.keys)
}

/// The machine's state after each event.
pub fn update(link: &str, paused: bool, jobs: usize) {
    let mut guard = LIVE.lock().unwrap();
    let Some(live) = guard.as_mut() else {
        return;
    };
    live.paused = paused;
    let hint = live.keys && link == "online" && !live.online_once;
    if link == "online" {
        live.online_once = true;
    }
    let next = title_for(&live.machine, link, paused, jobs);
    if live.title && next != live.shown {
        write_out(&title_sequence(&next));
    }
    live.shown = next;
    drop(guard);
    if hint {
        crate::ui::message("Press p to pause or resume, Ctrl-C to go offline.");
    }
}

/// Puts the terminal back: the old title, and line-at-a-time input. Safe to call twice.
pub fn end() {
    let Some(live) = LIVE.lock().unwrap().take() else {
        return;
    };
    if live.title {
        write_out(RESTORE_TITLE);
    }
    if let Some(was) = live.termios {
        // SAFETY: as in raw_keys.
        unsafe {
            libc::tcsetattr(0, libc::TCSANOW, &was);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_follow_the_state() {
        let t = |link, paused, jobs| title_for("box", link, paused, jobs);
        assert_eq!(t("connecting", false, 0), "RelayRunner · box · Connecting…");
        assert_eq!(
            t("online", false, 0),
            "RelayRunner · box · Waiting for jobs"
        );
        assert_eq!(t("online", true, 0), "RelayRunner · box · Paused");
        assert_eq!(t("online", false, 1), "RelayRunner · box · Running a job");
        assert_eq!(
            t("online", true, 2),
            "RelayRunner · box · Running 2 jobs, then paused"
        );
        assert_eq!(
            t("reconnecting", false, 1),
            "RelayRunner · box · Running a job, reconnecting…"
        );
        assert_eq!(
            t("reconnecting", false, 0),
            "RelayRunner · box · Reconnecting…"
        );
    }

    #[test]
    fn strips_control_characters_from_titles() {
        assert_eq!(title_sequence("a\x07b"), "\x1b]0;ab\x07");
    }
}
