//! Keeps the machine connected to the gateway: hello, status heartbeat, `run`
//! into a free slot, token rotation, close codes, backoff with jitter.

use crate::credentials::{self, Credentials};
use crate::events::{self, Event, State};
use crate::protocol::{
    GatewayMessage, Hello, JobState, JobUpdate, MachineMessage, QueueEntry, RunJob as JobInfo,
    parse_gateway,
};
use futures_util::{SinkExt, StreamExt};
use std::collections::BTreeSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

const CLOSE_REVOKED: u16 = 4001;
const CLOSE_REPLACED: u16 = 4002;
const CLOSE_POLICY: u16 = 1008;
const HEARTBEAT: Duration = Duration::from_secs(30);
const MIN_BACKOFF_MS: u64 = 1_000;
const MAX_BACKOFF_MS: u64 = 30_000;
const RECONNECT_SPREAD_MS: u64 = 10_000;

pub enum End {
    Stopped,
    /// `online` says whether it ever came online this time.
    Revoked {
        online: bool,
    },
    Replaced,
    Rejected(String),
}

/// What job tasks tell the connection.
enum FromJob {
    Update(JobUpdate, u32),
    Done(u32),
}

/// A job the gateway sent.
#[derive(Clone, Debug)]
pub struct Run {
    pub route_id: String,
    pub jit_config: String,
    /// Run it in the machine's VM, not on the machine itself.
    pub isolated: bool,
    /// Which job it is, when the gateway said.
    pub job: Option<JobInfo>,
}

pub type Report = Arc<dyn Fn(JobUpdate) + Send + Sync>;
/// Runs one job in the given slot (from 1) and reports its progress.
pub type RunJob =
    Arc<dyn Fn(Run, u32, Report) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

pub struct Options {
    pub credentials: Credentials,
    pub hello: Hello,
    pub run_job: RunJob,
    /// The runner version new jobs run on now, which changes when the runner updates.
    pub runner_version: Arc<dyn Fn() -> String + Send + Sync>,
    pub user_agent: String,
    pub stop: watch::Receiver<bool>,
}

/// The machine's state after each event, the `state` event the app reads.
#[derive(Clone, PartialEq)]
struct Live {
    link: &'static str,
    paused: bool,
    jobs: Vec<String>,
    /// Jobs waiting for a slot here, as the gateway last said. 0 while not connected.
    waiting: u32,
    /// The longest-waiting of them, longest first.
    queue: Vec<QueueEntry>,
    /// When jobs in the last hour went elsewhere because every slot was busy, in ms since the epoch.
    spilled: Vec<u64>,
}

struct Conn {
    options: Options,
    token: String,
    busy: BTreeSet<u32>,
    pending: Vec<MachineMessage>,
    live: Live,
    jobs_tx: mpsc::UnboundedSender<FromJob>,
    gateway_error: String,
    /// The runner version the gateway last heard on this socket.
    said_version: String,
    online: bool,
}

impl Conn {
    fn emit(&mut self, event: Event) {
        say(&event, self.slotted());
        let mut next = self.live.clone();
        match event {
            Event::Connecting { .. } if next.link == "online" => next.link = "reconnecting",
            Event::Connected {} => next.link = "online",
            Event::Disconnected { .. } => {
                next.link = "reconnecting";
                next.waiting = 0;
                next.queue.clear();
            }
            Event::Waiting {
                jobs,
                queue,
                spilled,
            } => {
                next.waiting = jobs;
                next.queue = queue;
                next.spilled = spilled;
            }
            Event::Paused { paused, .. } => next.paused = paused,
            _ => {}
        }
        if next != self.live {
            self.live = next;
            self.emit_state();
        }
    }

    fn emit_state(&self) {
        crate::live::update(self.live.link, self.live.paused, self.live.jobs.len());
        say(
            &Event::State(State {
                link: self.live.link,
                paused: self.live.paused,
                jobs: self.live.jobs.clone(),
                waiting: self.live.waiting,
                queue: self.live.queue.clone(),
                spilled: self.live.spilled.clone(),
                slots: self.options.hello.slots,
            }),
            false,
        );
    }

    /// Whether lines name the slot a job runs in: only with more than one.
    fn slotted(&self) -> bool {
        self.options.hello.slots > 1
    }

    /// A status, carrying the runner version only when it changed since the gateway heard it.
    fn status(&mut self) -> MachineMessage {
        let version = (self.options.runner_version)();
        let changed = version != self.said_version;
        if changed {
            self.said_version.clone_from(&version);
        }
        MachineMessage::Status {
            state: if self.busy.is_empty() { "idle" } else { "busy" },
            running: self.busy.len() as u32,
            runner_version: changed.then_some(version),
        }
    }

    fn start_job(&mut self, run: Run) -> MachineMessage {
        let route_id = run.route_id.clone();
        let slot = (1..).find(|s| !self.busy.contains(s)).unwrap();
        if slot > self.options.hello.slots {
            let running = self.busy.len();
            say(
                &Event::RunRefused {
                    route_id: route_id.clone(),
                    running,
                },
                false,
            );
            let message = if running == 1 {
                "The machine is already running a job.".to_string()
            } else {
                format!("The machine is already running {running} jobs.")
            };
            return MachineMessage::Job(JobUpdate {
                route_id,
                state: JobState::Failed,
                message: Some(message),
                usage: None,
            });
        }
        say(
            &Event::Run {
                route_id: route_id.clone(),
                slot,
                job: run.job.clone(),
            },
            self.slotted(),
        );
        self.live.jobs.push(route_id.clone());
        self.emit_state();
        self.busy.insert(slot);
        let tx = self.jobs_tx.clone();
        let report_tx = tx.clone();
        let report: Report = Arc::new(move |u| {
            let _ = report_tx.send(FromJob::Update(u, slot));
        });
        let job = (self.options.run_job)(run, slot, report);
        tokio::spawn(async move {
            job.await;
            let _ = tx.send(FromJob::Done(slot));
        });
        self.status()
    }

    /// A job task's news: the message to send.
    fn on_job(&mut self, news: FromJob) -> MachineMessage {
        match news {
            FromJob::Update(update, slot) => {
                say(
                    &Event::Job {
                        update: update.clone(),
                        slot,
                    },
                    self.slotted(),
                );
                if update.state != JobState::Started {
                    self.live.jobs.retain(|id| *id != update.route_id);
                    self.emit_state();
                }
                MachineMessage::Job(update)
            }
            FromJob::Done(slot) => {
                self.busy.remove(&slot);
                self.status()
            }
        }
    }
}

/// An event for the app, and a line for a person.
fn say(event: &Event, slotted: bool) {
    use crate::ui;
    let at = crate::events::local_time();
    match event {
        Event::Connecting { attempt: 1 } => ui::step(&format!("{at} Connecting…")),
        Event::Connected {} => ui::success(&format!("{at} Online. Waiting for jobs.")),
        Event::Disconnected {
            code,
            reason,
            retry_in_ms,
        } => {
            let secs = retry_in_ms.div_ceil(1000);
            let reason = if reason.is_empty() {
                String::new()
            } else {
                format!(" {reason}")
            };
            ui::warn(&format!(
                "{at} Disconnected ({code}{reason}). Retrying in {secs}s."
            ));
        }
        Event::GatewayError { message, .. } => ui::error(&format!("{at} Gateway: {message}")),
        Event::Run {
            route_id,
            slot,
            job,
        } => {
            let slot = if slotted {
                format!(" in slot {slot}")
            } else {
                String::new()
            };
            let name = match job {
                Some(JobInfo {
                    workflow: Some(workflow),
                    name,
                    ..
                }) => format!(" {workflow} › {name} ({route_id})"),
                Some(JobInfo { name, .. }) => format!(" {name} ({route_id})"),
                None => format!(" {route_id}"),
            };
            ui::step(&format!("{at} Starting job{name}{slot}"));
        }
        Event::Paused { paused, by } => {
            let by = by.as_ref().map(|b| format!(" by {b}")).unwrap_or_default();
            if *paused {
                let keys = if crate::live::keys() {
                    " Press p to resume."
                } else {
                    ""
                };
                ui::warn(&format!(
                    "{at} Paused{by}. Staying online, but new jobs skip this machine until it's resumed.{keys}"
                ));
            } else {
                ui::success(&format!("{at} Resumed{by}. Waiting for jobs."));
            }
        }
        Event::TokenNotSaved { message } => ui::warn(&format!(
            "{at} Couldn't save the machine's new token ({message}). Keeping the old one."
        )),
        Event::RunRefused { route_id, running } => {
            let running = match running {
                1 => "one".to_string(),
                n => n.to_string(),
            };
            ui::warn(&format!(
                "{at} Turned down job {route_id}: already running {running}."
            ));
        }
        Event::Job { update, slot } => {
            let slot = if slotted {
                format!(" (slot {slot})")
            } else {
                String::new()
            };
            let message = update
                .message
                .as_ref()
                .map(|m| format!(": {m}"))
                .unwrap_or_default();
            let state = match update.state {
                JobState::Started => "started",
                JobState::Finished => "finished",
                JobState::Failed => "failed",
            };
            let line = format!("{at} Job {}{slot} {state}{message}", update.route_id);
            match update.state {
                JobState::Failed => ui::error(&line),
                JobState::Finished => ui::success(&line),
                JobState::Started => ui::info(&line),
            }
        }
        _ => {}
    }
    events::emit(event);
}

fn backoff(attempt: u32) -> u64 {
    let base =
        MAX_BACKOFF_MS.min(MIN_BACKOFF_MS.saturating_mul(1 << attempt.saturating_sub(1).min(20)));
    // ±25% so machines that keep failing don't retry in step.
    (base as f64 * (0.75 + fastrand::f64() * 0.5)).round() as u64
}

fn connect_url(server: &str) -> String {
    let mut url = url::Url::parse(server).expect("credentials hold a valid URL");
    url.set_path("/api/machines/connect");
    let scheme = if url.scheme() == "http" { "ws" } else { "wss" };
    let _ = url.set_scheme(scheme);
    url.to_string()
}

pub async fn run(options: Options) -> End {
    let (jobs_tx, mut jobs_rx) = mpsc::unbounded_channel();
    let mut stop = options.stop.clone();
    let mut conn = Conn {
        token: options.credentials.token.clone(),
        options,
        busy: BTreeSet::new(),
        pending: Vec::new(),
        live: Live {
            link: "connecting",
            paused: false,
            jobs: Vec::new(),
            waiting: 0,
            queue: Vec::new(),
            spilled: Vec::new(),
        },
        jobs_tx,
        gateway_error: String::new(),
        said_version: String::new(),
        online: false,
    };
    let end = stay_connected(&mut conn, &mut jobs_rx, &mut stop).await;

    // A running job's runner finishes (or, after Ctrl-C, exits and cleans up) before this returns,
    // so its VM goes away and its end still shows. A second Ctrl-C exits on the spot.
    if !conn.busy.is_empty() {
        events::log(if conn.busy.len() == 1 {
            "Waiting for the running job to finish. Press Ctrl-C again to stop it now."
        } else {
            "Waiting for the running jobs to finish. Press Ctrl-C again to stop them now."
        });
    }
    while !conn.busy.is_empty() {
        let Some(news) = jobs_rx.recv().await else {
            break;
        };
        conn.on_job(news);
    }
    end
}

async fn stay_connected(
    conn: &mut Conn,
    jobs_rx: &mut mpsc::UnboundedReceiver<FromJob>,
    stop: &mut watch::Receiver<bool>,
) -> End {
    let mut attempt = 0;
    while !*stop.borrow() {
        attempt += 1;
        conn.emit(Event::Connecting { attempt });
        let (opened, code, reason, unauthorized) = session(conn, jobs_rx, stop).await;
        if *stop.borrow() {
            break;
        }
        if opened {
            attempt = 1;
        }
        match code {
            CLOSE_REPLACED => return End::Replaced,
            CLOSE_POLICY => {
                let message = [&conn.gateway_error, &reason]
                    .into_iter()
                    .find(|s| !s.is_empty());
                return End::Rejected(message.cloned().unwrap_or_else(|| "protocol error".into()));
            }
            _ if code == CLOSE_REVOKED || unauthorized => {
                return End::Revoked {
                    online: conn.online,
                };
            }
            _ => {}
        }
        let retry = if opened {
            fastrand::u64(0..=RECONNECT_SPREAD_MS)
        } else {
            backoff(attempt)
        };
        conn.emit(Event::Disconnected {
            code,
            reason: reason.clone(),
            retry_in_ms: retry,
        });

        // Wait, still hearing from jobs: their updates wait for the next hello.
        let sleep = tokio::time::sleep(Duration::from_millis(retry));
        tokio::pin!(sleep);
        loop {
            tokio::select! {
                _ = &mut sleep => break,
                _ = stop.changed() => break,
                Some(news) = jobs_rx.recv() => {
                    let message = conn.on_job(news);
                    if matches!(message, MachineMessage::Job(_)) { conn.pending.push(message); }
                }
            }
        }
    }
    End::Stopped
}

/// One socket's lifetime: (opened, close code, reason, upgrade refused with 401).
async fn session(
    conn: &mut Conn,
    jobs_rx: &mut mpsc::UnboundedReceiver<FromJob>,
    stop: &mut watch::Receiver<bool>,
) -> (bool, u16, String, bool) {
    let mut request = connect_url(&conn.options.credentials.server)
        .into_client_request()
        .unwrap();
    let headers = request.headers_mut();
    headers.insert(
        "authorization",
        format!("Bearer {}", conn.token).parse().unwrap(),
    );
    headers.insert("user-agent", conn.options.user_agent.parse().unwrap());

    let ws = tokio::select! {
        result = tokio_tungstenite::connect_async(request) => result,
        _ = stop.changed() => return (false, 1000, "machine going offline".into(), false),
    };
    let mut ws = match ws {
        Ok((ws, _)) => ws,
        // Unlike Node's WebSocket, tungstenite hands back the refused upgrade's response, so a bad
        // token shows up as a 401 here without asking again with a plain GET.
        Err(WsError::Http(response)) => {
            return (false, 1006, String::new(), response.status() == 401);
        }
        Err(e) => {
            events::log(&format!("Couldn't connect: {e}"));
            return (false, 1006, String::new(), false);
        }
    };

    conn.online = true;
    conn.emit(Event::Connected {});
    let mut hello = conn.options.hello.clone();
    conn.said_version = (conn.options.runner_version)();
    hello.runner_version.clone_from(&conn.said_version);
    let mut first = vec![MachineMessage::Hello(hello), conn.status()];
    first.append(&mut conn.pending);
    for message in first {
        if ws.send(Message::text(message.encode())).await.is_err() {
            return (true, 1006, String::new(), false);
        }
    }

    let mut heartbeat =
        tokio::time::interval_at(tokio::time::Instant::now() + HEARTBEAT, HEARTBEAT);
    loop {
        let outgoing = tokio::select! {
            _ = stop.changed() => {
                let frame = CloseFrame { code: CloseCode::Normal, reason: "machine going offline".into() };
                let _ = ws.close(Some(frame)).await;
                return (true, 1000, "machine going offline".into(), false);
            }
            _ = heartbeat.tick() => Some(conn.status()),
            Some(news) = jobs_rx.recv() => Some(conn.on_job(news)),
            frame = ws.next() => match frame {
                Some(Ok(Message::Text(text))) => match parse_gateway(&text) {
                    Err((code, message)) => {
                        conn.emit(Event::GatewayError { code: code.to_string(), message: message.clone() });
                        None
                    }
                    Ok(GatewayMessage::Run { route_id, jit_config, isolated, job }) => {
                        let job = JobInfo::read(job);
                        Some(conn.start_job(Run { route_id, jit_config, isolated, job }))
                    }
                    Ok(GatewayMessage::Waiting { jobs, queue, spilled }) => {
                        conn.emit(Event::Waiting { jobs, queue, spilled });
                        None
                    }
                    Ok(GatewayMessage::Paused { paused, by }) => {
                        conn.emit(Event::Paused { paused, by });
                        None
                    }
                    Ok(GatewayMessage::Token { token }) => {
                        // Saved first, then acknowledged: after token_saved the old one is dead.
                        match credentials::save_rotated_token(&conn.options.credentials, &token) {
                            Ok(()) => {
                                conn.token = token;
                                Some(MachineMessage::TokenSaved)
                            }
                            Err(message) => {
                                conn.emit(Event::TokenNotSaved { message });
                                None
                            }
                        }
                    }
                    Ok(GatewayMessage::Error { code, message }) => {
                        conn.emit(Event::GatewayError { code: code.to_string(), message: message.clone() });
                        conn.gateway_error = message;
                        None
                    }
                },
                Some(Ok(Message::Close(frame))) => {
                    let (code, reason) = frame.map_or((1005, String::new()), |f| (u16::from(f.code), f.reason.to_string()));
                    return (true, code, reason, false);
                }
                Some(Ok(_)) => None,
                Some(Err(_)) | None => return (true, 1006, String::new(), false),
            },
        };
        if let Some(message) = outgoing
            && let Err(_) = ws.send(Message::text(message.encode())).await
        {
            if matches!(message, MachineMessage::Job(_)) {
                conn.pending.push(message);
            }
            return (true, 1006, String::new(), false);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backs_off_within_bounds() {
        for attempt in 1..30 {
            let ms = backoff(attempt);
            assert!((750..=37_500).contains(&ms), "{attempt}: {ms}");
        }
    }

    #[test]
    fn builds_the_socket_url() {
        assert_eq!(
            connect_url("https://app.example"),
            "wss://app.example/api/machines/connect"
        );
        assert_eq!(
            connect_url("http://localhost:8787"),
            "ws://localhost:8787/api/machines/connect"
        );
    }
}
