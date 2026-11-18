import { describe, expect, test } from "vitest";
import { attentionItems } from "./attention.ts";
import { type LiveJob, type LiveJobs, NO_LIVE_JOBS } from "./live-jobs.ts";
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

const offline = { online: false, state: null, connectedAt: null } as const;

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

const queued = (...jobs: LiveJob[]): LiveJobs => ({ ...NO_LIVE_JOBS, queued: jobs });

describe("attentionItems", () => {
  test("is empty when nothing is stuck, even with a machine offline", () => {
    const machines = [machine({ id: "a", name: "laptop", status: offline })];
    expect(attentionItems(machines, NO_LIVE_JOBS)).toEqual([]);
    // A job another runner can take isn't stuck.
    const both = [...machines, machine({ id: "b", name: "server" })];
    expect(attentionItems(both, queued(job({})))).toEqual([]);
  });

  test("an offline machine with jobs waiting on it, fixed by whoever can", () => {
    const mine = machine({ id: "a", name: "laptop", status: offline, mine: true });
    const items = attentionItems(
      [mine],
      queued(job({ id: 1, environment: "machine:a" }), job({ id: 2, environment: "machine:a" })),
    );
    expect(items).toEqual([
      { key: "offline:a", text: "laptop is offline with 2 jobs waiting", fix: { kind: "connect" } },
    ]);
    const theirs = { ...mine, mine: false };
    expect(attentionItems([theirs], queued(job({ environment: "machine:a" })))[0]!.fix).toEqual({
      kind: "runner",
      machine: theirs,
    });
    const github = machine({ id: "g", name: "build-01", status: offline, source: "github" });
    expect(attentionItems([github], queued(job({})))[0]).toMatchObject({
      text: "build-01 is offline with 1 job waiting",
      fix: { kind: "github" },
    });
  });

  test("a paused machine with jobs waiting unpauses from the row when allowed", () => {
    const paused = machine({
      id: "a",
      name: "mini",
      paused: { at: "", by: null },
      canRevoke: true,
    });
    expect(attentionItems([paused], queued(job({ environment: "machine:a" })))).toEqual([
      {
        key: "paused:a",
        text: "mini is paused with 1 job waiting",
        fix: { kind: "unpause", machine: paused },
      },
    ]);
  });

  test("jobs no runner has the labels for, one row per set of labels", () => {
    const items = attentionItems(
      [machine({ id: "a", name: "server" })],
      queued(
        job({ id: 1, labels: ["self-hosted", "windows"] }),
        job({ id: 2, labels: ["self-hosted", "windows"] }),
        job({ id: 3, labels: ["gpu"] }),
        // Waiting on GitHub isn't stuck.
        job({ id: 4, labels: ["ubuntu-latest"], environment: "github:linux-2-core" }),
      ),
    );
    expect(items.map((item) => item.text)).toEqual([
      "2 jobs waiting for a runner with self-hosted, windows",
      "1 job waiting for a runner with gpu",
    ]);
  });

  test("a runner GitHub no longer has, without also reading as offline", () => {
    const gone = machine({
      id: "g",
      name: "build-01",
      status: offline,
      source: "github",
      github: { org: "acme", repo: null, runnerId: 7, missing: true, unreachable: false },
    });
    expect(attentionItems([gone], queued(job({})))).toEqual([
      {
        key: "missing:g",
        text: "build-01 was removed or re-registered on GitHub",
        fix: { kind: "add-runner" },
      },
    ]);
  });

  test("a runner near or past GitHub's update cutoff, restarted by its owner", () => {
    const runner = (days: number) => ({
      version: "2.329.0",
      update: "2.331.0",
      updateBy: new Date(Date.now() + days * 86_400_000).toISOString(),
    });
    const mine = machine({ id: "m", name: "studio", mine: true, runner: runner(-1) });
    const theirs = machine({ id: "t", name: "mini", runner: runner(3) });
    // Weeks before the cutoff it's only a note on the card.
    const later = machine({ id: "l", name: "laptop", runner: runner(20) });
    expect(attentionItems([mine, theirs, later], NO_LIVE_JOBS)).toEqual([
      { key: "runner-update:m", text: "studio needs a runner update", fix: { kind: "connect" } },
      {
        key: "runner-update:t",
        text: "mini needs a runner update soon",
        fix: { kind: "runner", machine: theirs },
      },
    ]);
  });
});
