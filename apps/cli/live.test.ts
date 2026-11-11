import { describe, expect, test } from "vitest";
import type { ConnectionEvent } from "./connection.ts";
import { INITIAL_STATE, keyAction, nextState, titleFor, titleSequence } from "./live.ts";

const play = (...events: ConnectionEvent[]) => events.reduce(nextState, INITIAL_STATE);
const title = (...events: ConnectionEvent[]) => titleFor(play(...events), "M3P0");

describe("the terminal title", () => {
  test("names the product and machine, then what it's doing", () => {
    expect(title()).toBe("RelayRunner · M3P0 · Connecting…");
    expect(title({ type: "connected" })).toBe("RelayRunner · M3P0 · Waiting for jobs");
  });

  test("follows a job from start to finish", () => {
    const run: ConnectionEvent = { type: "run", routeId: "7f3k", slot: 1 };
    const started: ConnectionEvent = {
      type: "job",
      update: { routeId: "7f3k", state: "started" },
      slot: 1,
    };
    expect(title({ type: "connected" }, run, started)).toBe("RelayRunner · M3P0 · Running a job");
    for (const state of ["finished", "failed"] as const)
      expect(
        title({ type: "connected" }, run, started, {
          type: "job",
          update: { routeId: "7f3k", state },
          slot: 1,
        }),
      ).toBe("RelayRunner · M3P0 · Waiting for jobs");
  });

  test("counts jobs running at once", () => {
    const run = (routeId: string, slot: number): ConnectionEvent => ({
      type: "run",
      routeId,
      slot,
    });
    const done = (routeId: string, slot: number): ConnectionEvent => ({
      type: "job",
      update: { routeId, state: "finished" },
      slot,
    });
    const connected: ConnectionEvent = { type: "connected" };
    expect(title(connected, run("a", 1), run("b", 2))).toBe("RelayRunner · M3P0 · Running 2 jobs");
    expect(title(connected, run("a", 1), run("b", 2), done("a", 1))).toBe(
      "RelayRunner · M3P0 · Running a job",
    );
  });

  test("says when it's paused, including while a job finishes", () => {
    const paused: ConnectionEvent = { type: "paused", paused: true, by: null };
    expect(title({ type: "connected" }, paused)).toBe("RelayRunner · M3P0 · Paused");
    expect(title({ type: "connected" }, { type: "run", routeId: "a", slot: 1 }, paused)).toBe(
      "RelayRunner · M3P0 · Running a job, then paused",
    );
    expect(
      title({ type: "connected" }, paused, { type: "paused", paused: false, by: "Zach" }),
    ).toBe("RelayRunner · M3P0 · Waiting for jobs");
  });

  test("says when it's reconnecting", () => {
    const dropped: ConnectionEvent = { type: "disconnected", code: 1006, reason: "", retryInMs: 1 };
    expect(title({ type: "connected" }, dropped)).toBe("RelayRunner · M3P0 · Reconnecting…");
    expect(title({ type: "connected" }, dropped, { type: "connected" })).toBe(
      "RelayRunner · M3P0 · Waiting for jobs",
    );
  });

  test("is written without control characters that would end it early", () => {
    expect(titleSequence("a\u0007b\nc")).toBe("\u001b]0;abc\u0007");
  });
});

describe("keys", () => {
  test("p pauses or resumes and Ctrl-C interrupts", () => {
    expect(keyAction("p")).toBe("toggle-pause");
    expect(keyAction("P")).toBe("toggle-pause");
    expect(keyAction("\u0003")).toBe("interrupt");
    expect(keyAction("x")).toBeNull();
  });
});
