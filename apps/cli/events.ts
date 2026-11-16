// `connect --events`: for an app that runs `connect` on someone's behalf, such as a menu bar app.
//
// stdout carries one JSON object per line and nothing else: everything `connect` would print for
// a person, job output included, goes to stderr instead. Each object has `v` (this format's
// version), `at` (an ISO time) and `type`. stdin takes one command per line: `pause` or `resume`.
//
// To go offline the way Ctrl-C does, start `connect` in its own process group and send that group
// SIGINT (a second one exits on the spot). Closing stdin goes offline too, for when the app quits
// or crashes, and lets a running job finish. Give it an anonymous pipe: on macOS, neither Node
// nor Bun sees a named FIFO close.

import { createInterface } from "node:readline";
import type { ConnectionEnd, ConnectionEvent } from "./connection.ts";
import type { LiveState } from "./live.ts";

const EVENTS_VERSION = 1;

export type AppEvent =
  // Signing in: the page to approve this machine on, and the code it shows.
  | { type: "sign-in"; url: string; code: string }
  // The machine `connect` runs as, once it's signed in.
  | { type: "machine"; id: string; name: string; server: string }
  // Everything the connection reports, as is: connecting, connected, run, job, paused and so on.
  | ConnectionEvent
  // The machine's state after each of those, the same one the terminal's title shows.
  | ({ type: "state" } & LiveState)
  // Which repo a job is from, once its runner config is checked.
  | { type: "job-repo"; routeId: string; repo: string }
  | { type: "offline"; reason: ConnectionEnd["reason"]; message?: string }
  // Something went wrong: `connect` stops after one from the CLI itself, but not after a failed
  // command, which carries the command.
  | { type: "error"; code: string; message: string; command?: string };

let write: ((line: string) => void) | null = null;

/** Sends stdout's writes to stderr from now on, and keeps stdout for emitEvent. */
export function startEvents() {
  if (write) return;
  const { stdout, stderr } = process;
  const toStdout = stdout.write.bind(stdout);
  write = (line) => void toStdout(line);
  stdout.write = stderr.write.bind(stderr) as typeof stdout.write;
}

/** Writes an event to stdout, when `connect` runs with --events. Otherwise does nothing. */
export function emitEvent(event: AppEvent, now?: Date) {
  if (!write) return;
  const at = (now ?? new Date()).toISOString();
  write(`${JSON.stringify({ v: EVENTS_VERSION, at, ...event })}\n`);
}

export type Command = "pause" | "resume";

/** The command a line of stdin asks for, or null for anything else. */
export function parseCommand(line: string): Command | null {
  const word = line.trim().toLowerCase();
  return word === "pause" || word === "resume" ? word : null;
}

/**
 * Reads commands from stdin until stop() is called. onClose runs when stdin closes first.
 */
export function readCommands(options: {
  onCommand: (command: Command) => void;
  onClose: () => void;
  input?: NodeJS.ReadableStream;
}) {
  const lines = createInterface({ input: options.input ?? process.stdin, terminal: false });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    const command = parseCommand(line);
    if (command) options.onCommand(command);
    else
      emitEvent({
        type: "error",
        code: "UNKNOWN_COMMAND",
        message: "Commands are `pause` and `resume`.",
        command: line.trim(),
      });
  });
  lines.once("close", options.onClose);
  return function stop() {
    lines.off("close", options.onClose);
    lines.close();
  };
}
