// Keeps this machine connected to the gateway's MachineLink (#66) for as long as `connect` runs:
//
// - GET /api/machines/connect as a WebSocket, with the machine token as a bearer token.
// - `hello` first, then `status` on every change and every 30 seconds as the heartbeat.
// - `run` starts one job through runJob() and reports its `job` progress. Capacity is one: a
//   second `run` while busy is answered with a failed `job` straight away.
// - `token` replaces the machine token: saveToken() stores it, the CLI answers `token_saved`, and
//   it connects with the new one from then on.
// - Close 4001 (revoked) and 4002 (replaced by another connection) end it, and so does 1008
//   (the gateway rejected something we sent, so retrying would repeat it). Anything else, such
//   as a network drop, a deploy or 4000 (missed heartbeats), reconnects with backoff.

import {
  encodeMessage,
  parseGatewayMessage,
  PROTOCOL_VERSION,
  type HelloMessage,
  type MachineMessage,
  type RunMessage,
} from "@relayrunner/machine-protocol";
import type { JobUpdate } from "./job.ts";
import { userAgent } from "./paths.ts";

export const CLOSE_REVOKED = 4001;
export const CLOSE_REPLACED = 4002;
const CLOSE_POLICY = 1008;

export type MachineState = "idle" | "busy";

// Why connect() returned.
export type ConnectionEnd =
  // Ctrl-C, or whoever owns the signal.
  | { reason: "stopped" }
  // The token was revoked or isn't valid any more: sign in again.
  | { reason: "revoked" }
  // Another `relayrunner connect` with the same token took over.
  | { reason: "replaced" }
  // The gateway rejected a message, usually because this CLI speaks an older protocol.
  | { reason: "rejected"; message: string };

// What happened, for the terminal.
export type ConnectionEvent =
  | { type: "connecting"; attempt: number }
  | { type: "connected" }
  | { type: "disconnected"; code: number; reason: string; retryInMs: number }
  | { type: "gateway-error"; code: string; message: string }
  | { type: "run"; routeId: string }
  | { type: "run-refused"; routeId: string }
  | { type: "job"; update: JobUpdate }
  // The gateway sent a new machine token and saveToken() couldn't store it. The old one keeps
  // working, and the gateway tries again on the next connect.
  | { type: "token-not-saved"; message: string }
  // Someone paused or resumed this machine. `by` is their name, or null for this machine's CLI.
  | { type: "paused"; paused: boolean; by: string | null };

export interface ConnectOptions {
  server: string;
  token: string;
  hello: Omit<HelloMessage, "v" | "type">;
  // Run one job and report its progress. Must not reject.
  runJob: (run: RunMessage, report: (update: JobUpdate) => void) => Promise<unknown>;
  // Store a new machine token the gateway sent (it rotates it on every connect). Throws if it
  // couldn't. Without it, the CLI doesn't offer to rotate and keeps the token it has.
  saveToken?: (token: string) => void;
  onEvent?: (event: ConnectionEvent) => void;
  signal?: AbortSignal;
  heartbeatMs?: number;
  // Reconnect delay before jitter: min(maxBackoffMs, minBackoffMs * 2^attempt).
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

// Node's WebSocket is undici's, which takes headers on its init object (the browser one can't
// send an Authorization header at all). @types/node only declares the protocols form.
const NodeWebSocket = WebSocket as unknown as new (
  url: string,
  init: { headers: Record<string, string> },
) => WebSocket;

export function connectUrl(server: string) {
  const url = new URL("/api/machines/connect", server);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  return url.toString();
}

export function backoff(attempt: number, min: number, max: number, random = Math.random) {
  const base = Math.min(max, min * 2 ** Math.max(0, attempt - 1));
  // ±25% so a gateway deploy doesn't get every machine back in the same instant.
  return Math.round(base * (0.75 + random() * 0.5));
}

export async function connect(options: ConnectOptions): Promise<ConnectionEnd> {
  const heartbeatMs = options.heartbeatMs ?? 30_000;
  const minBackoffMs = options.minBackoffMs ?? 1_000;
  const maxBackoffMs = options.maxBackoffMs ?? 30_000;
  const emit = options.onEvent ?? (() => {});
  const signal = options.signal;

  let state: MachineState = "idle";
  let socket: WebSocket | null = null;
  // The token to connect with: the saved one, then each one the gateway sends.
  let token = options.token;
  // Job updates sent while the socket was down. The gateway hears them after the next hello.
  const pending: MachineMessage[] = [];
  // The last `error` the gateway sent; it comes just before a 1008 close.
  let gatewayError = "";

  const send = (message: MachineMessage) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(encodeMessage(message));
    else if (message.type === "job") pending.push(message);
  };
  const sendStatus = () => send({ v: PROTOCOL_VERSION, type: "status", state });

  // Saved first, then acknowledged: once the gateway hears `token_saved` the old token is dead.
  const saveToken = (next: string) => {
    if (!options.saveToken) return;
    try {
      options.saveToken(next);
    } catch (error) {
      emit({
        type: "token-not-saved",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    token = next;
    send({ v: PROTOCOL_VERSION, type: "token_saved" });
  };

  const startJob = (run: RunMessage) => {
    if (state === "busy") {
      emit({ type: "run-refused", routeId: run.routeId });
      const update: JobUpdate = {
        routeId: run.routeId,
        state: "failed",
        message: "The machine is already running a job.",
      };
      send({ v: PROTOCOL_VERSION, type: "job", ...update });
      return;
    }
    emit({ type: "run", routeId: run.routeId });
    state = "busy";
    sendStatus();
    void options
      .runJob(run, (update) => {
        emit({ type: "job", update });
        send({ v: PROTOCOL_VERSION, type: "job", ...update });
      })
      .finally(() => {
        state = "idle";
        sendStatus();
      });
  };

  // One socket's lifetime. Resolves with the close code and reason, and whether it ever opened.
  const session = () =>
    new Promise<{ opened: boolean; code: number; reason: string }>((resolve) => {
      let opened = false;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const ws = new NodeWebSocket(connectUrl(options.server), {
        headers: { authorization: `Bearer ${token}`, "user-agent": userAgent },
      });
      socket = ws;

      let settled = false;
      const finish = (code: number, reason: string) => {
        if (settled) return;
        settled = true;
        clearInterval(heartbeat);
        signal?.removeEventListener("abort", onAbort);
        if (socket === ws) socket = null;
        resolve({ opened, code, reason });
      };
      const onAbort = () => {
        ws.close(1000, "machine going offline");
        finish(1000, "machine going offline");
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      ws.addEventListener("open", () => {
        opened = true;
        emit({ type: "connected" });
        const rotatesToken = options.saveToken ? true : undefined;
        ws.send(
          encodeMessage({ v: PROTOCOL_VERSION, type: "hello", ...options.hello, rotatesToken }),
        );
        sendStatus();
        for (const message of pending.splice(0)) send(message);
        heartbeat = setInterval(sendStatus, heartbeatMs);
      });
      ws.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        const parsed = parseGatewayMessage(event.data);
        if (!parsed.ok) {
          emit({ type: "gateway-error", code: parsed.reason, message: parsed.error });
          return;
        }
        const message = parsed.message;
        if (message.type === "run") startJob(message);
        else if (message.type === "paused")
          emit({ type: "paused", paused: message.paused, by: message.by });
        else if (message.type === "token") saveToken(message.token);
        else {
          gatewayError = message.message;
          emit({ type: "gateway-error", code: message.code, message: message.message });
        }
      });
      ws.addEventListener("close", (event) => finish(event.code, event.reason));
      // Node 22 fires only `error`, no `close`, when the upgrade fails, so end the attempt here.
      ws.addEventListener("error", () => {
        if (!opened) finish(1006, "");
      });
    });

  // A failed upgrade only surfaces as a bare error, so ask again with a plain GET to read the
  // status: the gateway answers 401 for a bad token and 426 for a good one. It has to be plain:
  // Cloudflare's edge answers 400 to an upgrade without a key, and one with a key would really
  // upgrade and replace this machine's socket.
  const tokenRejected = () =>
    fetch(new URL("/api/machines/connect", options.server), {
      headers: { authorization: `Bearer ${token}`, "user-agent": userAgent },
      signal: AbortSignal.timeout(10_000),
    }).then(
      async (response) => {
        await response.body?.cancel();
        return response.status === 401;
      },
      () => false,
    );

  let attempt = 0;
  while (!signal?.aborted) {
    attempt++;
    emit({ type: "connecting", attempt });
    const { opened, code, reason } = await session();
    if (signal?.aborted) break;
    if (opened) attempt = 1;

    if (code === CLOSE_REVOKED) return { reason: "revoked" };
    if (code === CLOSE_REPLACED) return { reason: "replaced" };
    if (code === CLOSE_POLICY)
      return { reason: "rejected", message: gatewayError || reason || "protocol error" };
    if (!opened && (await tokenRejected())) return { reason: "revoked" };

    const retryInMs = backoff(attempt, minBackoffMs, maxBackoffMs);
    emit({ type: "disconnected", code, reason, retryInMs });
    await delay(retryInMs, signal);
  }
  return { reason: "stopped" };
}

function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}
