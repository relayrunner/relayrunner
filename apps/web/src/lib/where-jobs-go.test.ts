import { describe, expect, test } from "vitest";
import type { Machine } from "./machines";
import { whereJobsGo } from "./where-jobs-go";

const machine = (over: Partial<Machine> = {}): Machine => ({
  id: over.name ?? "m",
  name: "atticus-mbp",
  os: "macos",
  arch: "arm64",
  lastSeenAt: null,
  revokedAt: null,
  createdAt: "2026-11-01T00:00:00Z",
  device: { kind: "laptop", model: "MacBook Pro" } as Machine["device"],
  status: { online: true, state: "idle", connectedAt: null },
  ...over,
});
const order = (...keys: ("machine" | "github" | "blacksmith")[]) => keys.map((key) => ({ key }));

describe("whereJobsGo", () => {
  test("one online machine first, GitHub after", () => {
    expect(whereJobsGo(order("machine", "github"), [machine()])).toEqual({
      tone: "go",
      text: "atticus-mbp is online. Private repo jobs run here, with GitHub-hosted as fallback.",
    });
  });

  test("the only machine is off", () => {
    const off = machine({ status: { online: false, state: null, connectedAt: null } });
    expect(whereJobsGo(order("machine", "github"), [off]).text).toBe(
      "atticus-mbp is offline, so jobs go to GitHub-hosted.",
    );
  });

  test("a paused machine doesn't count as ready", () => {
    const paused = machine({ paused: { at: "2026-11-08T00:00:00Z", by: null } });
    expect(whereJobsGo(order("machine", "github"), [paused]).tone).toBe("idle");
  });

  test("several machines, GitHub first", () => {
    const off = machine({
      name: "build-box",
      status: { online: false, state: null, connectedAt: null },
    });
    expect(whereJobsGo(order("github", "machine", "blacksmith"), [machine(), off]).text).toBe(
      "atticus-mbp is online. Jobs try GitHub-hosted first, then here, then Blacksmith.",
    );
  });

  test("counts ready runners when there are several", () => {
    const two = [machine(), machine({ name: "zach-mini" })];
    expect(whereJobsGo(order("machine", "github"), two).text).toBe(
      "2 of 2 runners online. Private repo jobs run here, with GitHub-hosted as fallback.",
    );
  });

  test("no machines yet", () => {
    expect(whereJobsGo(order("machine", "github"), []).text).toBe(
      "No self-hosted runner yet, so jobs run on GitHub-hosted.",
    );
  });

  test("self-hosted left out of the order", () => {
    expect(whereJobsGo(order("github", "blacksmith"), [machine()]).text).toBe(
      "Self-hosted isn't in the Router, so jobs never run here.",
    );
  });
});
