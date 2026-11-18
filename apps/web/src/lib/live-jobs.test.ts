import { describe, expect, test } from "vitest";
import { type LiveJob, runnerCounts, waitReason } from "./live-jobs.ts";
import type { Machine } from "./machines.ts";

const machine = (rest: Partial<Machine> & Pick<Machine, "id" | "name">): Machine => ({
  os: "linux",
  arch: "x64",
  labels: ["self-hosted", "Linux", "X64"],
  lastSeenAt: null,
  revokedAt: null,
  createdAt: "2026-11-01T00:00:00Z",
  status: { online: true, state: "idle", connectedAt: 0, slots: 1, running: 0 },
  ...rest,
});

const job = (rest: Partial<LiveJob>): LiveJob => ({
  id: 1,
  repositoryId: 1,
  repository: "acme/app",
  runId: 1,
  runAttempt: 1,
  workflow: "CI",
  name: "build",
  labels: ["self-hosted", "linux"],
  environment: "self-hosted:default",
  queuedAt: 0,
  startedAt: null,
  typical: null,
  ...rest,
});

const busy = { online: true, state: "busy", connectedAt: 0, slots: 2, running: 2 } as const;
const offline = { online: false, state: null, connectedAt: null } as const;

describe("runnerCounts", () => {
  test("counts each machine's slots as runners", () => {
    expect(
      runnerCounts([
        machine({ id: "a", name: "a", status: { ...busy, running: 1 } }),
        machine({ id: "b", name: "b", status: offline }),
        machine({ id: "c", name: "c", paused: { at: "", by: null } }),
        machine({ id: "e", name: "e", status: offline, paused: { at: "", by: null } }),
        machine({ id: "d", name: "d", revokedAt: "2026-11-02T00:00:00Z" }),
      ]),
    ).toEqual({ total: 5, running: 1, idle: 1, offline: 1, paused: 2 });
  });
});

describe("waitReason", () => {
  // Past GitHub's cutoff for a runner update.
  const overdue = { version: "2.329.0", update: "2.331.0", updateBy: "2026-01-01T00:00:00Z" };

  test("names the state of the machine a routed job waits for", () => {
    const routed = job({ environment: "machine:m" });
    const reason = (rest: Partial<Machine>) =>
      waitReason(routed, undefined, [machine({ id: "m", name: "studio", ...rest })]).text;
    expect(reason({ status: offline })).toBe("studio is offline");
    expect(reason({ paused: { at: "", by: null } })).toBe("studio is paused");
    expect(reason({ status: busy })).toBe("studio is busy");
    expect(reason({})).toBe("Starting on studio");
    // GitHub may not send an overdue runner the job at all.
    expect(reason({ runner: overdue })).toBe("studio needs a runner update");
    expect(reason({ runner: { ...overdue, updateBy: "2999-01-01T00:00:00Z" } })).toBe(
      "Starting on studio",
    );
    expect(waitReason(routed, undefined, []).text).toBe("Waiting for its machine");
  });

  test("matches a self-hosted job's labels against the workspace's runners, ignoring case", () => {
    const linux = machine({ id: "a", name: "a" });
    expect(waitReason(job({}), undefined, [linux])).toEqual({
      text: "1 idle runner match",
      problem: false,
    });
    expect(waitReason(job({}), undefined, [{ ...linux, status: busy }]).text).toBe(
      "1 matching, all busy",
    );
    expect(waitReason(job({}), undefined, [{ ...linux, status: offline }])).toEqual({
      text: "Matching runners are offline",
      problem: true,
    });
    expect(waitReason(job({}), undefined, [{ ...linux, runner: overdue }])).toEqual({
      text: "Matching runners need a runner update",
      problem: true,
    });
    expect(waitReason(job({ labels: ["self-hosted", "gpu"] }), undefined, [linux])).toEqual({
      text: "No runner with self-hosted, gpu",
      problem: true,
    });
    // A macOS machine that also runs Linux jobs in a VM takes them by its VM's labels.
    const mac = machine({
      id: "m",
      name: "m",
      labels: ["self-hosted", "macOS"],
      isolatedLabels: ["self-hosted", "Linux"],
    });
    expect(waitReason(job({}), undefined, [mac]).problem).toBe(false);
  });

  test("names the cloud service a job waits for", () => {
    expect(waitReason(job({ environment: "github:linux-2-core" }), undefined, []).text).toBe(
      "Waiting for GitHub",
    );
    const env = { key: "blacksmith:x", label: "blacksmith-2vcpu", detail: "Blacksmith" };
    expect(waitReason(job({ environment: env.key }), env, []).text).toBe("Waiting for Blacksmith");
  });
});
