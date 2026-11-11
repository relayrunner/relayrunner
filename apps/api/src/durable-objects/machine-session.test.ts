import {
  encodeMessage,
  PROTOCOL_VERSION,
  type MachineMessage,
} from "@relayrunner/machine-protocol";
import { describe, expect, test } from "vitest";
import {
  CLOSE,
  handleFrame,
  HEARTBEAT_TIMEOUT_MS,
  isTakeover,
  newSession,
  statusOf,
  type SessionState,
} from "./machine-session.ts";

type Unversioned = MachineMessage extends infer M
  ? M extends MachineMessage
    ? Omit<M, "v">
    : never
  : never;
const frame = (message: Unversioned) =>
  encodeMessage({ v: PROTOCOL_VERSION, ...message } as MachineMessage);
const hello = frame({
  type: "hello",
  machineId: "m1",
  os: "macos",
  arch: "arm64",
  runnerVersion: "2.329.0",
});

function said(frames: string[], start = 0) {
  let session: SessionState = newSession("m1", start);
  for (const [i, f] of frames.entries()) {
    const outcome = handleFrame(session, f, start + (i + 1) * 1000);
    expect(outcome).not.toHaveProperty("reply");
    session = outcome.state;
  }
  return session;
}

function rejected(session: SessionState, f: string | ArrayBuffer) {
  const outcome = handleFrame(session, f, 0);
  if (!("reply" in outcome)) throw new Error("expected a rejection");
  return {
    error: JSON.parse(outcome.reply) as { type: string; code: string },
    close: outcome.close,
  };
}

describe("machine session", () => {
  test("keeps the device a hello reports, for MachineLink to store", () => {
    const device = { kind: "laptop", model: "MacBook Pro", cpuCores: 12 } as const;
    const withDevice = frame({
      type: "hello",
      machineId: "m1",
      os: "macos",
      arch: "arm64",
      runnerVersion: "2.329.0",
      device,
    });
    expect(said([withDevice]).hello?.device).toEqual(device);
    expect(said([hello]).hello?.device).toBeUndefined();
  });

  test("a connected machine isn't online until it says hello", () => {
    expect(statusOf(newSession("m1", 0), 0).online).toBe(false);
    expect(statusOf(said([hello]), 1000)).toEqual({ online: true, state: "idle", connectedAt: 0 });
  });

  test("status messages set idle or busy", () => {
    const busy = said([hello, frame({ type: "status", state: "busy" })]);
    expect(statusOf(busy, 2000).state).toBe("busy");
    const idle = said([
      hello,
      frame({ type: "status", state: "busy" }),
      frame({ type: "status", state: "idle" }),
    ]);
    expect(statusOf(idle, 3000).state).toBe("idle");
  });

  test("any message counts as a heartbeat; silence past the timeout reads as offline", () => {
    const session = said([hello, frame({ type: "job", routeId: "r1", state: "started" })]);
    expect(session.lastHeardAt).toBe(2000);
    expect(statusOf(session, 2000 + HEARTBEAT_TIMEOUT_MS).online).toBe(true);
    expect(statusOf(session, 2001 + HEARTBEAT_TIMEOUT_MS).online).toBe(false);
  });

  test("hands job updates back to MachineLink", () => {
    const update = frame({ type: "job", routeId: "r1", state: "failed", message: "busy" });
    const outcome = handleFrame(said([hello]), update, 3000);
    expect("job" in outcome && outcome.job).toMatchObject({ routeId: "r1", state: "failed" });
  });

  test("hello must come first, once, and match the token's machine", () => {
    const fresh = newSession("m1", 0);
    expect(rejected(fresh, frame({ type: "status", state: "idle" })).error.code).toBe(
      "invalid_message",
    );
    expect(rejected(said([hello]), hello).error.code).toBe("invalid_message");
    const other = hello.replace('"m1"', '"m2"');
    expect(rejected(fresh, other).error).toMatchObject({ type: "error", code: "invalid_message" });
  });

  test("bad frames get an error message, then a policy close", () => {
    const fresh = newSession("m1", 0);
    expect(rejected(fresh, "not json")).toMatchObject({
      error: { code: "invalid_message" },
      close: { code: CLOSE.policy },
    });
    expect(rejected(fresh, JSON.stringify({ v: 99, type: "hello" })).error.code).toBe(
      "version_mismatch",
    );
    expect(rejected(fresh, new ArrayBuffer(4)).error.code).toBe("invalid_message");
  });
});

describe("token rotation", () => {
  test("remembers whether the CLI can save a new token", () => {
    const rotating = frame({
      type: "hello",
      machineId: "m1",
      os: "macos",
      arch: "arm64",
      runnerVersion: "2.329.0",
      rotatesToken: true,
    });
    expect(said([rotating]).hello?.rotatesToken).toBe(true);
    expect(said([hello]).hello?.rotatesToken).toBeUndefined();
  });

  test("token_saved finishes a rotation, and is only a heartbeat without one", () => {
    const saved = frame({ type: "token_saved" });
    const pending = { ...said([hello]), pendingTokenHash: "abc" };
    expect(handleFrame(pending, saved, 5000)).toEqual({
      state: { ...pending, lastHeardAt: 5000, pendingTokenHash: undefined },
      promote: "abc",
    });
    const outcome = handleFrame(said([hello]), saved, 5000);
    expect(outcome).toMatchObject({ state: { lastHeardAt: 5000 }, promote: undefined });
  });

  test("token_saved before hello is refused", () => {
    const outcome = handleFrame(newSession("m1", 0), frame({ type: "token_saved" }), 1000);
    expect(outcome).toMatchObject({ close: { code: CLOSE.policy } });
  });
});

describe("takeovers", () => {
  const boston = { ip: "198.51.100.1", country: "US", city: "Boston" };
  const lisbon = { ip: "203.0.113.9", country: "PT", city: "Lisbon" };
  const online = { ...said([hello]), from: boston };

  test("a live connection pushed out from another IP is one, for as long as it counts as online", () => {
    expect(isTakeover(online, lisbon, 30_000)).toBe(true);
    expect(isTakeover(online, lisbon, 1000 + HEARTBEAT_TIMEOUT_MS)).toBe(true);
  });

  test("the same IP, a quiet socket, or an unknown IP isn't", () => {
    expect(isTakeover(online, { ...boston, city: null }, 30_000)).toBe(false);
    expect(isTakeover(online, lisbon, 1001 + HEARTBEAT_TIMEOUT_MS)).toBe(false);
    expect(isTakeover(online, { ...lisbon, ip: null }, 30_000)).toBe(false);
    expect(isTakeover(online, undefined, 30_000)).toBe(false);
    expect(isTakeover({ ...newSession("m1", 0), from: boston }, lisbon, 1000)).toBe(false);
  });
});
