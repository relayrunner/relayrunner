// The messages a machine and the gateway exchange over the machine WebSocket. The API's
// MachineLink Durable Object holds one end and `relayrunner connect` holds the other.
//
// Every message is a JSON text frame carrying the protocol version in `v`. Either side rejects a
// message whose version it doesn't speak, so a gateway deploy and an older CLI fail loudly
// instead of misreading each other. Bump PROTOCOL_VERSION for any change an older peer would
// misread; adding an optional field doesn't need a bump.
//
// Auth isn't part of the protocol: the machine token goes on the WebSocket upgrade request.

import { z } from "zod";

export const PROTOCOL_VERSION = 1;

const version = z.literal(PROTOCOL_VERSION);

// A route is one pick that chose a machine. Its id is the suffix of the `rr-<route id>` label
// GitHub queues the job on.
const routeId = z.string().min(1);

// machine → gateway

// What kind of device the machine is and what it runs on, as the CLI read it. Every part is
// optional: the CLI sends what it could read cheaply and leaves out the rest.
export const DeviceKind = z.enum(["laptop", "desktop", "server", "vm", "unknown"]);

const text = z.string().trim().min(1).max(120);

export const Device = z.object({
  kind: DeviceKind,
  // A display name, such as "MacBook Pro" or "PowerEdge R650".
  model: text.optional(),
  // The raw identifier it came from, such as "Mac15,9" or a DMI product name.
  modelId: text.optional(),
  // The CPU, such as "Apple M3 Pro" or "Intel(R) Xeon(R) Gold 6338 CPU @ 2.00GHz".
  chip: text.optional(),
  cpuCores: z.number().int().positive().max(100_000).optional(),
  memoryMb: z.number().int().positive().max(1_000_000_000).optional(),
  // The OS name and version, such as "macOS 15.1" or "Ubuntu 24.04.1 LTS".
  osVersion: text.optional(),
});

const os = z.enum(["linux", "macos", "windows"]);
const arch = z.enum(["x64", "arm64", "arm"]);

// First message after the socket opens. The gateway doesn't route to the machine until it has
// one.
export const HelloMessage = z.object({
  v: version,
  type: z.literal("hello"),
  machineId: z.string().min(1),
  os,
  arch,
  // The actions/runner version installed on the machine, such as "2.329.0".
  runnerVersion: z.string().min(1),
  // The relayrunner CLI's own version, such as "0.7.0". Missing from CLIs older than 0.7.0.
  cliVersion: z.string().trim().min(1).max(40).optional(),
  // Missing from CLIs older than device reporting. A device the gateway can't read is dropped
  // rather than failing the hello, so a detection bug never keeps a machine offline.
  device: Device.optional().catch(undefined),
  // True when this CLI saves a new machine token from a `token` message. The gateway only rotates
  // the token of a machine that says so, since an older CLI would keep using the old one.
  rotatesToken: z.boolean().optional(),
  // How many jobs the machine runs at once (`connect --concurrency`). Missing from CLIs older than
  // concurrency, which run one.
  slots: z.number().int().positive().max(1_000).optional(),
  // A second place this machine runs jobs: a VM per job, with its own OS (`connect --isolated
  // --macos` on a Mac offers a Linux VM beside the Mac itself). The gateway says which place a job
  // goes to in its `run` message. Missing when the machine has one place, which is `os`.
  isolated: z.object({ os, arch }).optional(),
});

// Sent whenever the machine's state changes and again on an interval as its heartbeat.
export const StatusMessage = z.object({
  v: version,
  type: z.literal("status"),
  // busy while any slot runs a job, so a gateway that reads only `state` still works.
  state: z.enum(["idle", "busy"]),
  // How many jobs are running now. Missing from CLIs older than concurrency: busy then means one.
  running: z.number().int().nonnegative().max(1_000).optional(),
});

// Progress of the runner process the machine started for a `run` message. "finished" means the
// runner exited cleanly, not that the job passed: the job's conclusion comes from GitHub's
// workflow_job webhook. "failed" means the runner couldn't start or exited with an error.
export const JobMessage = z.object({
  v: version,
  type: z.literal("job"),
  routeId,
  state: z.enum(["started", "finished", "failed"]),
  message: z.string().optional(),
});

// The machine saved the token from the gateway's `token` message, so the old one can stop
// working. Only sent in reply to `token`.
export const TokenSavedMessage = z.object({
  v: version,
  type: z.literal("token_saved"),
});

export const MachineMessage = z.discriminatedUnion("type", [
  HelloMessage,
  StatusMessage,
  JobMessage,
  TokenSavedMessage,
]);

// gateway → machine

// Run one job: start `run.sh --jitconfig <jitConfig>` in a fresh work directory. The config is
// GitHub's encoded_jit_config for a one-job runner, so it's only good for this job.
export const RunMessage = z.object({
  v: version,
  type: z.literal("run"),
  routeId,
  jitConfig: z.string().min(1),
  // Run it in the machine's VM (the hello's `isolated`), not on the machine itself.
  isolated: z.boolean().optional(),
});

// Sent just before the gateway closes the socket because of something the machine sent.
export const ErrorMessage = z.object({
  v: version,
  type: z.literal("error"),
  code: z.enum(["version_mismatch", "invalid_message"]),
  message: z.string(),
});

// The machine was paused or resumed. Sent when it happens and, for a paused machine, after hello.
// A paused machine stays connected but gets no new jobs; one already running carries on. `by` is
// the name of the user who did it, or null when this machine's own CLI did.
export const PausedMessage = z.object({
  v: version,
  type: z.literal("paused"),
  paused: z.boolean(),
  by: z.string().nullable(),
});

// A new machine token, sent after the hello of a CLI that set `rotatesToken`. The CLI saves it in
// place of the one it connected with and answers `token_saved`, after which the old token stops
// working. Until then both work, so a CLI that couldn't save it still connects next time. A copy
// of the token file taken earlier (a backup, a synced dotfile) stops working after the next
// connect.
export const TokenMessage = z.object({
  v: version,
  type: z.literal("token"),
  token: z.string().min(1),
});

export const GatewayMessage = z.discriminatedUnion("type", [
  RunMessage,
  ErrorMessage,
  PausedMessage,
  TokenMessage,
]);

export type DeviceKind = z.infer<typeof DeviceKind>;
export type Device = z.infer<typeof Device>;
export type HelloMessage = z.infer<typeof HelloMessage>;
export type StatusMessage = z.infer<typeof StatusMessage>;
export type JobMessage = z.infer<typeof JobMessage>;
export type TokenSavedMessage = z.infer<typeof TokenSavedMessage>;
export type MachineMessage = z.infer<typeof MachineMessage>;
export type RunMessage = z.infer<typeof RunMessage>;
export type ErrorMessage = z.infer<typeof ErrorMessage>;
export type PausedMessage = z.infer<typeof PausedMessage>;
export type TokenMessage = z.infer<typeof TokenMessage>;
export type GatewayMessage = z.infer<typeof GatewayMessage>;

export type ParseResult<T> =
  | { ok: true; message: T }
  // invalid_json: the frame isn't JSON. version_mismatch: `v` is missing or isn't
  // PROTOCOL_VERSION. invalid_message: right version, wrong shape.
  | { ok: false; reason: "invalid_json" | "version_mismatch" | "invalid_message"; error: string };

// A text frame from the machine → typed message, or why it was rejected. Never throws.
export function parseMachineMessage(frame: string): ParseResult<MachineMessage> {
  return parse(MachineMessage, frame);
}

// A text frame from the gateway → typed message, or why it was rejected. Never throws.
export function parseGatewayMessage(frame: string): ParseResult<GatewayMessage> {
  return parse(GatewayMessage, frame);
}

// Typed message → text frame. Either side should only send what its schema allows.
export function encodeMessage(message: MachineMessage | GatewayMessage): string {
  return JSON.stringify(message);
}

function parse<T>(schema: z.ZodType<T>, frame: string): ParseResult<T> {
  let data: unknown;
  try {
    data = JSON.parse(frame);
  } catch (error) {
    return { ok: false, reason: "invalid_json", error: String(error) };
  }

  // Check the version before the shape, so a peer on another version gets a version error
  // rather than a confusing complaint about a field that changed.
  const v = typeof data === "object" && data !== null ? (data as { v?: unknown }).v : undefined;
  if (v !== PROTOCOL_VERSION) {
    return {
      ok: false,
      reason: "version_mismatch",
      error: `expected protocol version ${PROTOCOL_VERSION}, got ${JSON.stringify(v) ?? "none"}`,
    };
  }

  const result = schema.safeParse(data);
  if (!result.success) {
    return { ok: false, reason: "invalid_message", error: z.prettifyError(result.error) };
  }
  return { ok: true, message: result.data };
}
