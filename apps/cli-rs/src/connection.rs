//! Keeps the machine connected to the gateway. A port of apps/cli/connection.ts: hello, status
//! heartbeat, `run` into a free slot, token rotation, close codes, backoff with jitter.

use crate::credentials::{self, Credentials};
use crate::events;
use crate::job;
use crate::protocol::{GatewayMessage, Hello, JobState, JobUpdate, MachineMessage, parse_gateway};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use std::collections::BTreeSet;
use std::path::PathBuf;
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
    Revoked,
    Replaced,
    Rejected(String),
}

/// What job tasks tell the connection.
enum FromJob {
    Update(JobUpdate, u32),
    Done(u32),
}

pub struct Options {
    pub credentials: Credentials,
    pub hello: Hello,
    pub slot_dirs: Vec<PathBuf>,
    pub user_agent: String,
    pub stop: watch::Receiver<bool>,
}

/// The machine's state after each event, the `state` event the app reads.
#[derive(Clone, PartialEq)]
struct Live {
    link: &'static str,
    paused: bool,
    jobs: Vec<String>,
}

struct Conn {
    options: Options,
    token: String,
    busy: BTreeSet<u32>,
    pending: Vec<MachineMessage>,
    live: Live,
    jobs_tx: mpsc::UnboundedSender<FromJob>,
    gateway_error: String,
}

impl Conn {
    fn emit(&mut self, kind: &str, fields: serde_json::Value) {
        events::emit(kind, fields.clone());
        let mut next = self.live.clone();
        match kind {
            "connecting" if next.link == "online" => next.link = "reconnecting",
            "connected" => next.link = "online",
            "disconnected" => next.link = "reconnecting",
            "paused" => next.paused = fields["paused"].as_bool().unwrap_or(next.paused),
            _ => {}
        }
        if next != self.live {
            self.live = next;
            self.emit_state();
        }
    }

    fn emit_state(&self) {
        events::emit(
            "state",
            json!({ "link": self.live.link, "paused": self.live.paused, "jobs": self.live.jobs }),
        );
    }

    fn status(&self) -> MachineMessage {
        MachineMessage::Status {
            state: if self.busy.is_empty() { "idle" } else { "busy" },
            running: self.busy.len() as u32,
            runner_version: None,
        }
    }

    fn start_job(&mut self, route_id: String, jit_config: String) -> Option<MachineMessage> {
        let slot = (1..).find(|s| !self.busy.contains(s)).unwrap();
        if slot as usize > self.options.slot_dirs.len() {
            let running = self.busy.len();
            events::emit(
                "run-refused",
                json!({ "routeId": route_id, "running": running }),
            );
            let message = if running == 1 {
                "The machine is already running a job.".to_string()
            } else {
                format!("The machine is already running {running} jobs.")
            };
            return Some(MachineMessage::Job(JobUpdate {
                route_id,
                state: JobState::Failed,
                message: Some(message),
            }));
        }
        events::emit("run", json!({ "routeId": route_id, "slot": slot }));
        self.live.jobs.push(route_id.clone());
        self.emit_state();
        self.busy.insert(slot);
        let dir = self.options.slot_dirs[slot as usize - 1].clone();
        let tx = self.jobs_tx.clone();
        tokio::spawn(async move {
            let report_tx = tx.clone();
            job::run(dir, slot, route_id, jit_config, move |u| {
                let _ = report_tx.send(FromJob::Update(u, slot));
            })
            .await;
            let _ = tx.send(FromJob::Done(slot));
        });
        Some(self.status())
    }

    /// A job task's news: the message to send, if any.
    fn on_job(&mut self, news: FromJob) -> MachineMessage {
        match news {
            FromJob::Update(update, slot) => {
                events::emit("job", json!({ "update": update, "slot": slot }));
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
        },
        jobs_tx,
        gateway_error: String::new(),
    };

    let mut attempt = 0;
    while !*stop.borrow() {
        attempt += 1;
        conn.emit("connecting", json!({ "attempt": attempt }));
        let (opened, code, reason, unauthorized) =
            session(&mut conn, &mut jobs_rx, &mut stop).await;
        if *stop.borrow() {
            break;
        }
        if opened {
            attempt = 1;
        }
        match code {
            CLOSE_REVOKED => return End::Revoked,
            CLOSE_REPLACED => return End::Replaced,
            CLOSE_POLICY => {
                let message = [&conn.gateway_error, &reason]
                    .into_iter()
                    .find(|s| !s.is_empty());
                return End::Rejected(message.cloned().unwrap_or_else(|| "protocol error".into()));
            }
            _ if unauthorized => return End::Revoked,
            _ => {}
        }
        let retry = if opened {
            fastrand::u64(0..=RECONNECT_SPREAD_MS)
        } else {
            backoff(attempt)
        };
        conn.emit(
            "disconnected",
            json!({ "code": code, "reason": reason, "retryInMs": retry }),
        );

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

    conn.emit("connected", json!({}));
    let mut hello = conn.options.hello.clone();
    hello.slots = conn.options.slot_dirs.len() as u32;
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
                        conn.emit("gateway-error", json!({ "code": code, "message": message }));
                        None
                    }
                    Ok(GatewayMessage::Run { route_id, jit_config, isolated }) => {
                        if isolated {
                            // VMs (isolated.ts) aren't part of the spike.
                            Some(MachineMessage::Job(JobUpdate {
                                route_id,
                                state: JobState::Failed,
                                message: Some("This build can't run jobs in a VM yet.".into()),
                            }))
                        } else {
                            conn.start_job(route_id, jit_config)
                        }
                    }
                    Ok(GatewayMessage::Paused { paused, by }) => {
                        conn.emit("paused", json!({ "paused": paused, "by": by }));
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
                                conn.emit("token-not-saved", json!({ "message": message }));
                                None
                            }
                        }
                    }
                    Ok(GatewayMessage::Error { code, message }) => {
                        conn.emit("gateway-error", json!({ "code": code, "message": message }));
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
