//! What a person sees: the look of @clack/prompts output (a bar down the
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
pub(crate) enum Style {
    Gray,
    Green,
    Blue,
    Yellow,
    Red,
    Cyan,
    Dim,
    Strike,
}

pub(crate) fn paint(style: Style, text: &str) -> String {
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

static TO_STDERR: AtomicBool = AtomicBool::new(false);

/// Sends what people read to stderr, so stdout carries only a command's `--json`.
pub fn use_stderr() {
    TO_STDERR.store(true, Ordering::SeqCst);
}

fn to_stderr() -> bool {
    crate::events::on() || TO_STDERR.load(Ordering::SeqCst)
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

pub(crate) fn write(text: &str) {
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
pub(crate) struct RawMode(libc::termios);

impl RawMode {
    /// Keys one at a time, unechoed, with Ctrl-C as a key rather than a signal.
    pub(crate) fn start() -> Option<RawMode> {
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

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Key {
    Up,
    Down,
    Left,
    Right,
    Space,
    Enter,
    Cancel,
    Char(u8),
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
        b' ' => Key::Space,
        b'k' | b'w' => Key::Up,
        b'j' | b's' => Key::Down,
        b'h' => Key::Left,
        b'l' => Key::Right,
        0x1b => {
            let mut seq = [0u8; 2];
            if input.read(&mut seq).unwrap_or(0) == 2 && seq[0] == b'[' {
                match seq[1] {
                    b'A' => Key::Up,
                    b'B' => Key::Down,
                    b'C' => Key::Right,
                    b'D' => Key::Left,
                    _ => Key::Other,
                }
            } else {
                Key::Cancel
            }
        }
        c if c.is_ascii_graphic() => Key::Char(c.to_ascii_lowercase()),
        _ => Key::Other,
    }
}

/// What a key press does to a prompt.
enum Step<T> {
    Stay,
    Done(T),
    Cancel,
}

/// Draws a prompt under `question`, its lines from `render`, and redraws it after each key until
/// `on_key` answers or cancels. Then it leaves the question with `summary`, the answer as text.
/// None when cancelled or when nobody's at a terminal to ask.
fn prompt<S, T>(
    question: &str,
    state: &mut S,
    render: impl Fn(&S) -> Vec<String>,
    mut on_key: impl FnMut(&mut S, Key) -> Step<T>,
    summary: impl Fn(&S) -> String,
) -> Option<T> {
    if !can_ask() {
        return None;
    }
    let raw = RawMode::start()?;
    let mut stdin = std::io::stdin().lock();
    let draw = |state: &S| {
        let lines = render(state);
        let mut out = format!(
            "{}\n{}  {question}\n",
            paint(Style::Gray, BAR),
            paint(Style::Cyan, "◆")
        );
        for line in &lines {
            out.push_str(&format!("{}  {line}\n", paint(Style::Cyan, BAR)));
        }
        out.push_str(&format!("{}\n", paint(Style::Cyan, BAR_END)));
        (out, lines.len() + 3)
    };
    write("\x1b[?25l");
    let (out, mut height) = draw(state);
    write(&out);
    let answer = loop {
        match on_key(state, read_key(&mut stdin)) {
            Step::Stay => {}
            Step::Done(answer) => break Some(answer),
            Step::Cancel => break None,
        }
        let (out, next) = draw(state);
        write(&format!("\x1b[{height}A\x1b[J{out}"));
        height = next;
    };
    drop(raw);
    let bar = paint(Style::Gray, BAR);
    let (symbol, text) = match answer {
        Some(_) => (paint(Style::Green, "◇"), paint(Style::Dim, &summary(state))),
        None => (
            paint(Style::Red, "■"),
            paint(Style::Strike, &paint(Style::Dim, &summary(state))),
        ),
    };
    write(&format!(
        "\x1b[{height}A\x1b[J{bar}\n{symbol}  {question}\n{bar}  {text}\n\x1b[?25h"
    ));
    answer
}

fn hint_of(choice: &Choice) -> String {
    choice
        .hint
        .as_ref()
        .map(|h| format!(" {}", paint(Style::Dim, &format!("({h})"))))
        .unwrap_or_default()
}

/// Asks to pick one, with the arrow keys and Enter. None when cancelled (Ctrl-C or Escape) or
/// when nobody's at a terminal to ask.
pub fn select(question: &str, choices: &[Choice], initial: usize) -> Option<usize> {
    if choices.is_empty() {
        return None;
    }
    let n = choices.len();
    let mut current = initial.min(n - 1);
    prompt(
        question,
        &mut current,
        |&current| {
            choices
                .iter()
                .enumerate()
                .map(|(i, choice)| {
                    if i == current {
                        format!(
                            "{} {}{}",
                            paint(Style::Green, "●"),
                            choice.label,
                            hint_of(choice)
                        )
                    } else {
                        format!(
                            "{} {}",
                            paint(Style::Dim, "○"),
                            paint(Style::Dim, &choice.label)
                        )
                    }
                })
                .collect()
        },
        |current, key| match key {
            Key::Up | Key::Left => {
                *current = (*current + n - 1) % n;
                Step::Stay
            }
            Key::Down | Key::Right => {
                *current = (*current + 1) % n;
                Step::Stay
            }
            Key::Enter => Step::Done(*current),
            Key::Cancel => Step::Cancel,
            _ => Step::Stay,
        },
        |&current| choices[current].label.clone(),
    )
}

/// Asks to pick any number, all picked to start with: Space picks or unpicks, `a` all or none,
/// Enter answers. The picks in order; None when cancelled.
pub fn multiselect(question: &str, choices: &[Choice]) -> Option<Vec<usize>> {
    if choices.is_empty() {
        return Some(Vec::new());
    }
    let n = choices.len();
    let mut state = (0usize, vec![true; n]);
    let picked = |picks: &[bool]| (0..n).filter(|&i| picks[i]).collect::<Vec<_>>();
    prompt(
        question,
        &mut state,
        |(current, picks)| {
            choices
                .iter()
                .enumerate()
                .map(|(i, choice)| {
                    let box_ = if picks[i] {
                        paint(Style::Green, "◼")
                    } else if i == *current {
                        paint(Style::Cyan, "◻")
                    } else {
                        paint(Style::Dim, "◻")
                    };
                    if i == *current {
                        format!("{box_} {}{}", choice.label, hint_of(choice))
                    } else {
                        format!("{box_} {}", paint(Style::Dim, &choice.label))
                    }
                })
                .collect()
        },
        |(current, picks), key| match key {
            Key::Up | Key::Left => {
                *current = (*current + n - 1) % n;
                Step::Stay
            }
            Key::Down | Key::Right => {
                *current = (*current + 1) % n;
                Step::Stay
            }
            Key::Space => {
                picks[*current] = !picks[*current];
                Step::Stay
            }
            Key::Char(b'a') => {
                let all = picks.iter().all(|&p| p);
                picks.iter_mut().for_each(|p| *p = !all);
                Step::Stay
            }
            Key::Enter => Step::Done(picked(picks)),
            Key::Cancel => Step::Cancel,
            _ => Step::Stay,
        },
        |(_, picks)| {
            let labels: Vec<&str> = picked(picks)
                .into_iter()
                .map(|i| choices[i].label.as_str())
                .collect();
            if labels.is_empty() {
                "none".to_string()
            } else {
                labels.join(", ")
            }
        },
    )
}

/// Asks yes or no: the arrow keys switch, `y` or `n` answer at once, Enter takes what's shown.
/// None when cancelled.
pub fn confirm(question: &str, initial: bool) -> Option<bool> {
    let mut yes = initial;
    prompt(
        question,
        &mut yes,
        |&yes| {
            let option = |on: bool, label: &str| {
                if on {
                    format!("{} {label}", paint(Style::Green, "●"))
                } else {
                    format!("{} {}", paint(Style::Dim, "○"), paint(Style::Dim, label))
                }
            };
            vec![format!(
                "{} {} {}",
                option(yes, "Yes"),
                paint(Style::Dim, "/"),
                option(!yes, "No")
            )]
        },
        |yes, key| match key {
            Key::Up | Key::Down | Key::Left | Key::Right => {
                *yes = !*yes;
                Step::Stay
            }
            Key::Char(b'y') => {
                *yes = true;
                Step::Done(true)
            }
            Key::Char(b'n') => {
                *yes = false;
                Step::Done(false)
            }
            Key::Enter => Step::Done(*yes),
            Key::Cancel => Step::Cancel,
            _ => Step::Stay,
        },
        |&yes| if yes { "Yes" } else { "No" }.to_string(),
    )
}

/// A unified diff with added lines green, removed ones red and the rest dim.
pub fn colored_diff(diff: &str) -> String {
    diff.lines()
        .map(|line| {
            let style = if line.starts_with('+') && !line.starts_with("+++") {
                Style::Green
            } else if line.starts_with('-') && !line.starts_with("---") {
                Style::Red
            } else {
                Style::Dim
            };
            paint(style, line)
        })
        .collect::<Vec<_>>()
        .join("\n")
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
        assert!(matches!(key(b" "), Key::Space));
        assert!(matches!(key(b"\x1b[C"), Key::Right));
        assert!(matches!(key(b"Y"), Key::Char(b'y')));
        assert!(matches!(key(b"\x7f"), Key::Other));
    }
}
