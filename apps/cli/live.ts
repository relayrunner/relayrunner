// What a running `relayrunner connect` shows outside its log: the terminal tab's title, kept to
// the machine's live state, and the keys it answers to.

import * as clack from "@clack/prompts";
import type { ConnectionEvent } from "./connection.ts";

export interface LiveState {
  link: "connecting" | "online" | "reconnecting";
  paused: boolean;
  // The route id of the job it's running.
  job: string | null;
}

export const INITIAL_STATE: LiveState = { link: "connecting", paused: false, job: null };

/** The state after a connection event. */
export function nextState(state: LiveState, event: ConnectionEvent): LiveState {
  switch (event.type) {
    case "connecting":
      return { ...state, link: state.link === "online" ? "reconnecting" : state.link };
    case "connected":
      return { ...state, link: "online" };
    case "disconnected":
      // A job's runner keeps going while the socket reconnects.
      return { ...state, link: "reconnecting" };
    case "run":
      return { ...state, job: event.routeId };
    case "job":
      return event.update.state === "started" || event.update.routeId !== state.job
        ? state
        : { ...state, job: null };
    case "paused":
      return { ...state, paused: event.paused };
    default:
      return state;
  }
}

/**
 * The terminal title for a state, such as "RelayRunner · M3P0 · Waiting for jobs". It leads with
 * the product so the tab says what's running in it, and ends with the part that changes.
 */
export function titleFor(state: LiveState, machine: string) {
  return `RelayRunner · ${machine} · ${statusText(state)}`;
}

function statusText({ link, paused, job }: LiveState) {
  if (link === "connecting") return "Connecting…";
  if (link === "reconnecting") return job ? "Running a job, reconnecting…" : "Reconnecting…";
  if (job) return paused ? "Running a job, then paused" : "Running a job";
  return paused ? "Paused" : "Waiting for jobs";
}

// OSC 0 sets the window and tab title. xterm's title stack (CSI 22;0t / 23;0t) saves the title
// the shell had and puts it back on exit, in the terminals that keep one (iTerm2, xterm, VTE,
// Windows Terminal, Ghostty, kitty); the rest ignore it.
const ESC = "\u001b";
const BEL = "\u0007";
export const SAVE_TITLE = `${ESC}[22;0t`;
export const RESTORE_TITLE = `${ESC}[23;0t`;

export function titleSequence(title: string) {
  // Control characters would end the sequence early.
  // oxlint-disable-next-line no-control-regex -- stripping them is the point.
  return `${ESC}]0;${title.replace(/[\u0000-\u001f\u007f]/g, "")}${BEL}`;
}

/** What a key pressed in the terminal asks for. */
export function keyAction(key: string): "toggle-pause" | "interrupt" | null {
  if (key === "\u0003") return "interrupt"; // Ctrl-C, which raw mode no longer sends as SIGINT.
  if (key === "p" || key === "P") return "toggle-pause";
  return null;
}

export interface Live {
  /** The machine's state so far. */
  readonly state: LiveState;
  /** Feed every connection event through, after logging it. */
  onEvent(event: ConnectionEvent): void;
  /** Put the terminal back: the old title, and cooked input. Safe to call twice. */
  end(): void;
}

/**
 * Starts the live title (when stdout is a terminal) and the keys (when stdin is one): `p` calls
 * onTogglePause, and Ctrl-C is sent on as SIGINT, since raw mode stops the terminal doing that.
 */
export function startLive(options: {
  machine: string;
  onTogglePause: (state: LiveState) => void;
}): Live {
  const { stdin, stdout } = process;
  const showTitle = stdout.isTTY;
  const keys = stdin.isTTY;
  let state = INITIAL_STATE;
  let title = titleFor(state, options.machine);
  let ended = false;
  if (showTitle) stdout.write(SAVE_TITLE + titleSequence(title));

  const onKey = (key: string) => {
    const action = keyAction(key);
    if (action === "toggle-pause") options.onTogglePause(state);
    else if (action === "interrupt") {
      // To the whole process group, as the terminal would, so a running job's runner hears it
      // too and cleans up.
      try {
        process.kill(0, "SIGINT");
      } catch {
        process.emit("SIGINT", "SIGINT");
      }
    }
  };
  if (keys) {
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.on("data", onKey);
    stdin.resume();
  }

  return {
    get state() {
      return state;
    },
    onEvent(event) {
      // The hint, once, the first time it comes online.
      if (keys && event.type === "connected" && state.link === "connecting")
        clack.log.message("Press p to pause or resume, Ctrl-C to go offline.");
      state = nextState(state, event);
      const next = titleFor(state, options.machine);
      if (showTitle && next !== title) stdout.write(titleSequence(next));
      title = next;
    },
    end() {
      if (ended) return;
      ended = true;
      if (showTitle) stdout.write(RESTORE_TITLE);
      if (keys) {
        stdin.off("data", onKey);
        stdin.setRawMode(false);
        stdin.pause();
      }
    },
  };
}
