import { describe, expect, test } from "vitest";
import { attentionItems, githubCheckedAt } from "./attention.ts";
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
});

test("githubCheckedAt is the oldest check of the runners added from GitHub", () => {
  const github = (checkedAt: number | null) => ({
    org: "acme",
    repo: null,
    runnerId: 1,
    missing: false,
    unreachable: checkedAt === null,
    checkedAt,
  });
  expect(githubCheckedAt([machine({ id: "a", name: "laptop" })])).toBeNull();
  expect(
    githubCheckedAt([
      machine({ id: "a", name: "a", github: github(2_000) }),
      machine({ id: "b", name: "b", github: github(1_000) }),
      machine({ id: "c", name: "c", github: github(null) }),
    ]),
  ).toBe(1_000);
});
