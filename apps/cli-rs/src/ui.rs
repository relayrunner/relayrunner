//! What a person sees: the same look as the TypeScript CLI's @clack/prompts output (a bar down the
//! left with a symbol per line), a pick-one prompt, and a spinner. Output goes to stderr when
//! stdout carries `--events`, and is coloured only on a terminal without NO_COLOR.

use std::io::{IsTerminal, Read, Write};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

const BAR: &str = "│";
const BAR_START: &str = "┌";
const BAR_END: &str = "└";

#[derive(Clone, Copy)]
enum Style {
    Gray,
    Green,
    Blue,
    Yellow,
    Red,
    Cyan,
    Dim,
    Strike,
}

fn paint(style: Style, text: &str) -> String {
    if !colored() {
        return text.to_string();
    }
    let code = match style {
        Style::Gray => "90",
        Style::Green => "32",
        Style::Blue => "34",
        Style::Yellow => "33",
        Style::Red => "31",
        Style::Cyan => "36",
        Style::Dim => "2",
        Style::Strike => "9",
    };
    format!("\x1b[{code}m{text}\x1b[0m")
}

fn to_stderr() -> bool {
    crate::events::on()
}

/// Whether the stream people read is a terminal.
pub fn interactive() -> bool {
    if to_stderr() {
        std::io::stderr().is_terminal()
    } else {
        std::io::stdout().is_terminal()
    }
}

/// Someone is at a terminal to answer a question: stdin and stdout are both terminals.
pub fn can_ask() -> bool {
    !to_stderr() && std::io::stdin().is_terminal() && std::io::stdout().is_terminal()
}

fn colored() -> bool {
    interactive() && std::env::var_os("NO_COLOR").is_none_or(|v| v.is_empty())
}

fn write(text: &str) {
    if to_stderr() {
        let mut err = std::io::stderr().lock();
        let _ = err.write_all(text.as_bytes());
        let _ = err.flush();
    } else {
        let mut out = std::io::stdout().lock();
        let _ = out.write_all(text.as_bytes());
        let _ = out.flush();
    }
}

/// `symbol  first line`, then `│  next line` for the rest, after a bare `│`.
fn entry(symbol: &str, text: &str) {
    let bar = paint(Style::Gray, BAR);
    let mut out = format!("{bar}\n");
    for (i, line) in text.lines().enumerate() {
        let lead = if i == 0 { symbol } else { bar.as_str() };
        out.push_str(&format!("{lead}  {line}\n"));
    }
    if text.is_empty() {
        out.push_str(&format!("{symbol}\n"));
    }
    write(&out);
}

pub fn intro(title: &str) {
    write(&format!("{}  {title}\n", paint(Style::Gray, BAR_START)));
}

pub fn outro(text: &str) {
    write(&format!(
        "{}\n{}  {text}\n\n",
        paint(Style::Gray, BAR),
        paint(Style::Gray, BAR_END)
    ));
}

pub fn info(text: &str) {
    entry(&paint(Style::Blue, "●"), text);
}

pub fn step(text: &str) {
    entry(&paint(Style::Green, "◇"), text);
}

pub fn success(text: &str) {
    entry(&paint(Style::Green, "◆"), text);
}

pub fn warn(text: &str) {
    entry(&paint(Style::Yellow, "▲"), text);
}

pub fn error(text: &str) {
    entry(&paint(Style::Red, "■"), text);
}

/// A line with only the bar beside it.
pub fn message(text: &str) {
    entry(&paint(Style::Gray, BAR), text);
}

/// A titled box, as clack's note draws it.
pub fn note(body: &str, title: &str) {
    let width = body
        .lines()
        .map(|l| l.chars().count())
        .chain([title.chars().count()])
        .max()
        .unwrap_or(0)
        + 2;
    let bar = paint(Style::Gray, BAR);
    let mut out = format!(
        "{bar}\n{}  {title} {}\n",
        paint(Style::Green, "◇"),
        paint(
            Style::Gray,
            &format!(
                "{}╮",
                "─".repeat(width.saturating_sub(title.chars().count() + 1))
            )
        )
    );
    let side = paint(Style::Gray, BAR);
    out.push_str(&format!("{bar}{}{side}\n", " ".repeat(width + 2)));
    for line in body.lines() {
        let pad = width - line.chars().count();
        out.push_str(&format!(
            "{bar}  {}{}{side}\n",
            paint(Style::Dim, line),
            " ".repeat(pad)
        ));
    }
    out.push_str(&format!("{bar}{}{side}\n", " ".repeat(width + 2)));
    out.push_str(&paint(
        Style::Gray,
        &format!("├{}╯\n", "─".repeat(width + 2)),
    ));
    write(&out);
}

/// One choice in `select`.
pub struct Choice {
    pub label: String,
    pub hint: Option<String>,
}

/// Puts the terminal into character-at-a-time mode until dropped.
struct RawMode(libc::termios);

impl RawMode {
    fn start(keep_signals: bool) -> Option<RawMode> {
        // SAFETY: tcgetattr and tcsetattr only read and write the struct we pass.
        unsafe {
            let mut was: libc::termios = std::mem::zeroed();
            if libc::tcgetattr(0, &mut was) != 0 {
                return None;
            }
            let mut raw = was;
            raw.c_lflag &= !(libc::ICANON | libc::ECHO);
            if !keep_signals {
                raw.c_lflag &= !libc::ISIG;
            }
            raw.c_cc[libc::VMIN] = 1;
            raw.c_cc[libc::VTIME] = 0;
            (libc::tcsetattr(0, libc::TCSANOW, &raw) == 0).then_some(RawMode(was))
        }
    }
}

impl Drop for RawMode {
    fn drop(&mut self) {
        // SAFETY: as above.
        unsafe {
            libc::tcsetattr(0, libc::TCSANOW, &self.0);
        }
    }
}

enum Key {
    Up,
    Down,
    Enter,
    Cancel,
    Other,
}

fn read_key(input: &mut impl Read) -> Key {
    let mut byte = [0u8; 1];
    if input.read(&mut byte).unwrap_or(0) == 0 {
        return Key::Cancel;
    }
    match byte[0] {
        b'\r' | b'\n' => Key::Enter,
        3 | 4 => Key::Cancel,
        b'k' | b'w' => Key::Up,
        b'j' | b's' => Key::Down,
        0x1b => {
            let mut seq = [0u8; 2];
            if input.read(&mut seq).unwrap_or(0) == 2 && seq[0] == b'[' {
                match seq[1] {
                    b'A' => Key::Up,
                    b'B' => Key::Down,
                    _ => Key::Other,
                }
            } else {
                Key::Cancel
            }
        }
        _ => Key::Other,
    }
}

/// Asks to pick one, with the arrow keys and Enter. None when cancelled (Ctrl-C or Escape) or
/// when nobody's at a terminal to ask.
pub fn select(question: &str, choices: &[Choice], initial: usize) -> Option<usize> {
    if !can_ask() || choices.is_empty() {
        return None;
    }
    let raw = RawMode::start(false)?;
    let mut stdin = std::io::stdin().lock();
    let mut current = initial.min(choices.len() - 1);
    let render = |current: usize| {
        let mut out = format!(
            "{}\n{}  {question}\n",
            paint(Style::Gray, BAR),
            paint(Style::Cyan, "◆")
        );
        for (i, choice) in choices.iter().enumerate() {
            let line = if i == current {
                let hint = choice
                    .hint
                    .as_ref()
                    .map(|h| format!(" {}", paint(Style::Dim, &format!("({h})"))))
                    .unwrap_or_default();
                format!("{} {}{hint}", paint(Style::Green, "●"), choice.label)
            } else {
                format!(
                    "{} {}",
                    paint(Style::Dim, "○"),
                    paint(Style::Dim, &choice.label)
                )
            };
            out.push_str(&format!("{}  {line}\n", paint(Style::Cyan, BAR)));
        }
        out.push_str(&format!("{}\n", paint(Style::Cyan, BAR_END)));
        out
    };
    // The prompt's height, to redraw it in place.
    let height = choices.len() + 3;
    write("\x1b[?25l");
    write(&render(current));
    let picked = loop {
        match read_key(&mut stdin) {
            Key::Up => current = (current + choices.len() - 1) % choices.len(),
            Key::Down => current = (current + 1) % choices.len(),
            Key::Enter => break Some(current),
            Key::Cancel => break None,
            Key::Other => continue,
        }
        write(&format!("\x1b[{height}A\x1b[J{}", render(current)));
    };
    drop(raw);
    let bar = paint(Style::Gray, BAR);
    let done = match picked {
        Some(i) => format!(
            "{bar}\n{}  {question}\n{bar}  {}\n",
            paint(Style::Green, "◇"),
            paint(Style::Dim, &choices[i].label)
        ),
        None => format!(
            "{bar}\n{}  {question}\n{bar}  {}\n",
            paint(Style::Red, "■"),
            paint(Style::Strike, &paint(Style::Dim, &choices[current].label))
        ),
    };
    write(&format!("\x1b[{height}A\x1b[J{done}\x1b[?25h"));
    picked
}

static SPINNING: Mutex<Option<std::thread::JoinHandle<()>>> = Mutex::new(None);
static SPIN: AtomicBool = AtomicBool::new(false);

/// Shows `text` with a spinner beside it until `stop_spinner`. Off a terminal it shows nothing
/// until then.
pub fn spinner(text: &str) {
    if !interactive() || SPIN.swap(true, Ordering::SeqCst) {
        return;
    }
    let text = text.to_string();
    write(&format!("{}\n\x1b[?25l", paint(Style::Gray, BAR)));
    let handle = std::thread::spawn(move || {
        let frames = ["◒", "◐", "◓", "◑"];
        let mut i = 0;
        while SPIN.load(Ordering::SeqCst) {
            write(&format!(
                "\r\x1b[K{}  {text}",
                paint(Style::Cyan, frames[i % frames.len()])
            ));
            i += 1;
            std::thread::sleep(Duration::from_millis(80));
        }
    });
    *SPINNING.lock().unwrap() = Some(handle);
}

/// Ends the spinner with `text`, marked done, or failed when `ok` is false.
pub fn stop_spinner(text: &str, ok: bool) {
    let spinning = SPIN.swap(false, Ordering::SeqCst);
    if let Some(handle) = SPINNING.lock().unwrap().take() {
        let _ = handle.join();
    }
    let symbol = if ok {
        paint(Style::Green, "◇")
    } else {
        paint(Style::Red, "■")
    };
    if spinning {
        write(&format!("\r\x1b[K{symbol}  {text}\n\x1b[?25h"));
    } else {
        entry(&symbol, text);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_keys() {
        let key = |bytes: &[u8]| read_key(&mut &bytes[..]);
        assert!(matches!(key(b"\x1b[A"), Key::Up));
        assert!(matches!(key(b"\x1b[B"), Key::Down));
        assert!(matches!(key(b"j"), Key::Down));
        assert!(matches!(key(b"\r"), Key::Enter));
        assert!(matches!(key(b"\x03"), Key::Cancel));
        assert!(matches!(key(b""), Key::Cancel));
        assert!(matches!(key(b"x"), Key::Other));
    }
}
