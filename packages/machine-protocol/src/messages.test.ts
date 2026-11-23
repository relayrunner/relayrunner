import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  encodeMessage,
  parseGatewayMessage,
  parseMachineMessage,
  type GatewayMessage,
  type MachineMessage,
} from "./messages.ts";

const v = PROTOCOL_VERSION;

describe("parseMachineMessage", () => {
  // fixtures.test.ts round-trips every field. These are the bare messages an older CLI sends.
  const messages: MachineMessage[] = [
    {
      v,
      type: "hello",
      machineId: "mch_1",
      os: "macos",
      arch: "arm64",
      runnerVersion: "2.329.0",
    },
    { v, type: "status", state: "idle" },
    { v, type: "status", state: "busy" },
  ];

  it.each(messages)("round-trips $type", (message) => {
    expect(parseMachineMessage(encodeMessage(message))).toEqual({ ok: true, message });
  });

  it("rejects a frame that isn't JSON", () => {
    expect(parseMachineMessage("{nope")).toMatchObject({ ok: false, reason: "invalid_json" });
  });

  it("drops a device it can't read instead of failing the hello", () => {
    const hello = {
      v,
      type: "hello",
      machineId: "mch_1",
      os: "linux",
      arch: "x64",
      runnerVersion: "2.329.0",
    };
    const parsed = parseMachineMessage(
      JSON.stringify({ ...hello, device: { kind: "toaster", cpuCores: -1 } }),
    );
    expect(parsed).toEqual({ ok: true, message: { ...hello, device: undefined } });
    const badVm = parseMachineMessage(JSON.stringify({ ...hello, vm: { cpus: 0 } }));
    expect(badVm).toMatchObject({ ok: true, message: { vm: undefined } });
  });

  it("drops usage it can't read instead of failing the job message", () => {
    const job = { v, type: "job", routeId: "7f3k", state: "finished" };
    const parsed = parseMachineMessage(JSON.stringify({ ...job, usage: { cpuP95: 7 } }));
    expect(parsed).toEqual({ ok: true, message: { ...job, usage: undefined } });
  });

  it("rejects another protocol version before checking the shape", () => {
    expect(parseMachineMessage(JSON.stringify({ v: 2, type: "renamed" }))).toMatchObject({
      ok: false,
      reason: "version_mismatch",
      error: "expected protocol version 1, got 2",
    });
  });

  it("rejects a message with no version", () => {
    expect(parseMachineMessage(JSON.stringify({ type: "status", state: "idle" }))).toMatchObject({
      ok: false,
      reason: "version_mismatch",
    });
    expect(parseMachineMessage("null")).toMatchObject({ ok: false, reason: "version_mismatch" });
  });

  it("rejects an unknown type", () => {
    expect(parseMachineMessage(JSON.stringify({ v, type: "pause" }))).toMatchObject({
      ok: false,
      reason: "invalid_message",
    });
  });

  it("rejects a slot count below one", () => {
    expect(
      parseMachineMessage(
        JSON.stringify({
          v,
          type: "hello",
          machineId: "mch_1",
          os: "linux",
          arch: "x64",
          runnerVersion: "2.329.0",
          slots: 0,
        }),
      ),
    ).toMatchObject({ ok: false, reason: "invalid_message" });
  });

  it("rejects a bad field", () => {
    expect(
      parseMachineMessage(JSON.stringify({ v, type: "status", state: "sleeping" })),
    ).toMatchObject({ ok: false, reason: "invalid_message" });
  });

  it("rejects gateway messages", () => {
    const run: GatewayMessage = { v, type: "run", routeId: "7f3k", jitConfig: "abc" };
    expect(parseMachineMessage(encodeMessage(run))).toMatchObject({
      ok: false,
      reason: "invalid_message",
    });
  });
});

describe("parseGatewayMessage", () => {
  it("rejects a run without a JIT config", () => {
    expect(
      parseGatewayMessage(JSON.stringify({ v, type: "run", routeId: "7f3k", jitConfig: "" })),
    ).toMatchObject({ ok: false, reason: "invalid_message" });
  });

  it("rejects machine messages", () => {
    expect(parseGatewayMessage(JSON.stringify({ v, type: "status", state: "idle" }))).toMatchObject(
      { ok: false, reason: "invalid_message" },
    );
  });
});
