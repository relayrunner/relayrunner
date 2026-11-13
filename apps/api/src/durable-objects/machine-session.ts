// What MachineLink does with each frame a machine sends, kept free of Durable Object APIs so it
// can be tested on its own. MachineLink stores a SessionState as each socket's attachment, so it
// survives the object hibernating between frames.

import {
  encodeMessage,
  parseMachineMessage,
  PROTOCOL_VERSION,
  type HelloMessage,
  type JobMessage,
} from "@relayrunner/machine-protocol";
import type { RequestOrigin } from "../device-origin.ts";

// The header GET /api/machines/connect uses to tell MachineLink which machine authenticated.
// MachineLink isn't reachable from outside the API Worker, so only that route can set it.
export const MACHINE_ID_HEADER = "x-relayrunner-machine-id";
// ...and where the connection came from (a RequestOrigin as JSON), which request.cf can't carry.
export const MACHINE_ORIGIN_HEADER = "x-relayrunner-machine-origin";

// The machine sends `status` at least this often (the CLI's heartbeat is 30 seconds)...
export const HEARTBEAT_INTERVAL_MS = 30_000;
// ...and the gateway closes a socket that has been silent for this long.
export const HEARTBEAT_TIMEOUT_MS = 90_000;

// WebSocket close codes the gateway uses. The CLI reconnects with backoff after any other code.
export const CLOSE = {
  // The machine sent something the protocol doesn't allow. An `error` message comes first.
  policy: 1008,
  // Nothing heard for HEARTBEAT_TIMEOUT_MS. The CLI should reconnect.
  timeout: 4000,
  // The machine was revoked in the dashboard. The CLI should stop and say so.
  revoked: 4001,
  // The same machine opened a newer socket. The CLI holding this one should exit.
  replaced: 4002,
} as const;

export interface SessionState {
  machineId: string;
  connectedAt: number;
  lastHeardAt: number;
  // Set by the machine's `hello`. Until then the machine isn't online.
  hello?: Pick<
    HelloMessage,
    | "os"
    | "arch"
    | "runnerVersion"
    | "cliVersion"
    | "device"
    | "rotatesToken"
    | "slots"
    | "isolated"
    | "vm"
  >;
  state?: "idle" | "busy";
  // Jobs running, from the last `status`. Unset from a CLI older than concurrency (runningOf).
  running?: number;
  // Where the connection came from, when the edge said.
  from?: RequestOrigin;
  // SHA-256 of the token sent in a `token` message, until the machine says it saved it.
  pendingTokenHash?: string;
}

export type FrameOutcome =
  // `job` is set when the frame was a job update, and `promote` (the token's hash) when the machine
  // saved the token it was sent, for MachineLink to act on.
  | { state: SessionState; job?: JobMessage; promote?: string }
  | { state: SessionState; reply: string; close: { code: number; reason: string } };

export function newSession(machineId: string, now: number, from?: RequestOrigin): SessionState {
  return { machineId, connectedAt: now, lastHeardAt: now, from };
}

/**
 * Whether a new connection replacing `old` should be reported to the machine's owner: the old one
 * was online (said hello, not stale: the same window statusOf uses) and the new one comes from
 * another IP. A CLI that restarts or reconnects after a network drop has usually lost its old
 * socket, or connects from the same address.
 */
export function isTakeover(old: SessionState, from: RequestOrigin | undefined, now: number) {
  return Boolean(
    old.hello && !isStale(old, now) && old.from?.ip && from?.ip && old.from.ip !== from.ip,
  );
}

export function handleFrame(
  session: SessionState,
  frame: string | ArrayBuffer,
  now: number,
): FrameOutcome {
  if (typeof frame !== "string") return reject(session, "invalid_message", "frames must be text");

  const parsed = parseMachineMessage(frame);
  if (!parsed.ok) {
    return reject(
      session,
      parsed.reason === "version_mismatch" ? "version_mismatch" : "invalid_message",
      parsed.error,
    );
  }

  const message = parsed.message;
  const heard = { ...session, lastHeardAt: now };
  if (message.type === "hello") {
    if (session.hello) return reject(session, "invalid_message", "hello was already sent");
    if (message.machineId !== session.machineId)
      return reject(session, "invalid_message", "machineId doesn't match this machine's token");
    const { os, arch, runnerVersion, cliVersion, device, rotatesToken, slots, isolated, vm } =
      message;
    // A machine that just said hello has no job from this gateway yet.
    return {
      state: {
        ...heard,
        hello: { os, arch, runnerVersion, cliVersion, device, rotatesToken, slots, isolated, vm },
        state: "idle",
        running: 0,
      },
    };
  }

  if (!session.hello) return reject(session, "invalid_message", "send hello first");
  if (message.type === "status")
    return {
      state: {
        ...heard,
        state: message.state,
        running: message.running ?? (message.state === "busy" ? 1 : 0),
      },
    };
  // A repeat, or one for a rotation already finished, only counts as a heartbeat.
  if (message.type === "token_saved")
    return {
      state: { ...heard, pendingTokenHash: undefined },
      promote: session.pendingTokenHash,
    };
  // Job progress for a route. Hearing it still counts as a heartbeat.
  return { state: heard, job: message };
}

export interface MachineStatus {
  online: boolean;
  // Null while offline.
  state: "idle" | "busy" | null;
  // Epoch ms of the current connection, or null while offline.
  connectedAt: number | null;
  // How many jobs it runs at once (1 for a CLI older than concurrency, and while offline), and how
  // many it reported running (0 while offline).
  slots: number;
  running: number;
}

export const OFFLINE: MachineStatus = {
  online: false,
  state: null,
  connectedAt: null,
  slots: 1,
  running: 0,
};

// A machine is online while it holds a socket that has said hello and isn't stale.
export function statusOf(session: SessionState | null | undefined, now: number): MachineStatus {
  if (!session?.hello || isStale(session, now)) return OFFLINE;
  const state = session.state ?? "idle";
  return {
    online: true,
    state,
    connectedAt: session.connectedAt,
    slots: session.hello.slots ?? 1,
    running: session.running ?? (state === "busy" ? 1 : 0),
  };
}

export function isStale(session: SessionState, now: number) {
  return now - session.lastHeardAt > HEARTBEAT_TIMEOUT_MS;
}

function reject(
  session: SessionState,
  code: "version_mismatch" | "invalid_message",
  message: string,
): FrameOutcome {
  return {
    state: session,
    reply: encodeMessage({ v: PROTOCOL_VERSION, type: "error", code, message }),
    close: { code: CLOSE.policy, reason: code },
  };
}
