import { PassThrough } from "node:stream";
import { afterAll, describe, expect, test, vi } from "vitest";
import { emitEvent, parseCommand, readCommands, startEvents } from "./events.ts";

const { stdout, stderr } = process;
const stdoutWrite = stdout.write;
const stderrWrite = stderr.write;
afterAll(() => {
  stdout.write = stdoutWrite;
  stderr.write = stderrWrite;
});

// startEvents keeps whatever stdout.write is when it's called, so these stand in for both streams.
const toStdout = vi.fn((_line: string) => true);
const toStderr = vi.fn((_line: string) => true);
stdout.write = toStdout as unknown as typeof stdout.write;
stderr.write = toStderr as unknown as typeof stderr.write;

describe("events", () => {
  test("does nothing before startEvents", () => {
    emitEvent({ type: "connected" });
    expect(toStdout).not.toHaveBeenCalled();
  });

  test("writes one JSON line per event to stdout, and everything else to stderr", () => {
    startEvents();
    emitEvent(
      { type: "machine", id: "m1", name: "laptop", server: "https://app.example.test" },
      new Date("2026-11-16T18:00:00.000Z"),
    );
    expect(toStdout).toHaveBeenCalledExactlyOnceWith(
      '{"v":1,"at":"2026-11-16T18:00:00.000Z","type":"machine","id":"m1","name":"laptop","server":"https://app.example.test"}\n',
    );
    process.stdout.write("Online. Waiting for jobs.\n");
    expect(toStderr).toHaveBeenCalledWith("Online. Waiting for jobs.\n");
    expect(toStdout).toHaveBeenCalledTimes(1);
  });
});

describe("parseCommand", () => {
  test("knows pause and resume", () => {
    expect(parseCommand("pause\n")).toBe("pause");
    expect(parseCommand("  RESUME ")).toBe("resume");
    expect(parseCommand("stop")).toBeNull();
  });
});

describe("readCommands", () => {
  const lines = () => toStdout.mock.calls.map(([line]) => JSON.parse(String(line)));

  test("runs each command, reports unknown ones, and calls onClose when stdin ends", async () => {
    const input = new PassThrough();
    const onCommand = vi.fn();
    const closed = new Promise<void>((resolve) =>
      readCommands({ onCommand, onClose: resolve, input }),
    );
    input.write("pause\nresume\n\nreboot\n");
    input.end();
    await closed;
    expect(onCommand.mock.calls).toEqual([["pause"], ["resume"]]);
    expect(lines().at(-1)).toMatchObject({
      type: "error",
      code: "UNKNOWN_COMMAND",
      command: "reboot",
    });
  });

  test("stop() doesn't count as stdin closing", () => {
    const onClose = vi.fn();
    const stop = readCommands({ onCommand: vi.fn(), onClose, input: new PassThrough() });
    stop();
    expect(onClose).not.toHaveBeenCalled();
  });
});
