import { beforeAll, describe, expect, test } from "vitest";
import { recordEvent } from "./activity.ts";
import {
  p95,
  peakWaiting,
  routingHealth,
  setupReason,
  unroutableReasons,
} from "./admin-routing.ts";
import { createDb, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import * as testing from "./testing.ts";

let env: Env;

beforeAll(async () => {
  env = await testing.createTestEnv();
});

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;
// 14:30 UTC, so the 24-hour window runs from 15:00 yesterday to 15:00 today.
const now = new Date("2026-11-13T14:30:00Z");
const at = (msAgo: number) => new Date(now.getTime() - msAgo);

describe("p95", () => {
  test("takes the nearest rank, or null with nothing to rank", () => {
    expect(p95([])).toBeNull();
    expect(p95([5])).toBe(5);
    expect(p95(Array.from({ length: 100 }, (_, i) => i + 1))).toBe(95);
    expect(p95([3, 1, 2])).toBe(3);
  });
});

describe("unroutableReasons", () => {
  test("lists each skipped step once, and providers the order leaves out", () => {
    expect(
      unroutableReasons({
        reason: "No runner available: …",
        walk: {
          step: null,
          skipped: [
            { key: "machine", reason: "machine_full" },
            { key: "github", reason: "not_configured" },
            { key: "machine", reason: "machine_full" },
          ],
          notInOrder: ["blacksmith"],
        },
      }),
    ).toEqual([
      { kind: "routing", provider: "machine", reason: "machine_full" },
      { kind: "routing", provider: "github", reason: "not_configured" },
      { kind: "routing", provider: "blacksmith", reason: "not_in_order" },
    ]);
  });

  test("a relay that stopped before the order is a setup problem", () => {
    expect(
      unroutableReasons({
        reason: "No runner available: this GitHub App installation is suspended.",
        walk: null,
      }),
    ).toEqual([{ kind: "setup", provider: null, reason: "install_suspended" }]);
    expect(setupReason("No runner available: RelayRunner doesn't have access to acme/app.")).toBe(
      "no_repo_access",
    );
    expect(setupReason("the org's Default runner group doesn't allow public repositories")).toBe(
      "runner_group",
    );
    expect(
      setupReason("No runner available: RelayRunner couldn't read this job's repository and run."),
    ).toBe("unreadable_job");
    expect(setupReason("something new")).toBe("other");
  });
});

describe("peakWaiting", () => {
  const from = 0;
  const job = (createdAt: number, endAt: number | null) => ({
    workspaceId: "w",
    createdAt,
    startedAt: endAt,
    endAt,
  });

  test("counts the most jobs waiting at once in each bucket", () => {
    const peaks = peakWaiting(
      [job(10, 30), job(20, 40), job(25, 120), job(130, 140)],
      from,
      100,
      3,
      250,
    );
    // Three overlap at 25–30. In the second bucket one carries over until 120 and another waits
    // later, never together. None wait in the third.
    expect(peaks).toEqual([3, 1, 0]);
  });

  test("a job still waiting fills every bucket after it was queued", () => {
    expect(peakWaiting([job(50, null)], from, 100, 3, 250)).toEqual([1, 1, 1]);
  });

  test("back-to-back jobs don't overlap", () => {
    expect(peakWaiting([job(10, 20), job(20, 30)], from, 100, 1, 50)).toEqual([1]);
  });
});

describe("routingHealth", () => {
  test("sums how relays ended, why, and how long machine jobs waited, leaving our own out", async () => {
    const db = createDb(env.DB);
    const customer = await testing.signIn(env);
    const { workspace } = await testing.createWorkspace(env, customer.cookie, "Cabal", "cabal");
    const op = await testing.signInOperator(env);
    const { workspace: ours } = await testing.createWorkspace(env, op.cookie, "Ours", "ours");

    let run = 0;
    const decision = (workspaceId: string, createdAt: Date, waited: boolean) => {
      run += 1;
      return {
        workspaceId,
        repositoryId: 5_000,
        runId: run,
        runAttempt: 1,
        step: "machine",
        runner: `rr-${run}`,
        skipped: [],
        notInOrder: [],
        machine: ["self-hosted"],
        github: [],
        waitedAt: waited ? createdAt : null,
        createdAt,
      };
    };
    await db.insert(schema.routeDecision).values([
      decision(workspace.id, at(2 * HOUR), false),
      decision(workspace.id, at(2 * HOUR), true),
      decision(workspace.id, at(30 * MIN), true),
      // Outside the window.
      decision(workspace.id, at(30 * HOUR), false),
      // One of ours.
      decision(ours.id, at(HOUR), false),
    ]);

    const failed = (
      workspaceId: string,
      occurredAt: Date,
      walk: unknown,
      reason = "No runner available",
    ) =>
      recordEvent(db, {
        workspaceId,
        type: "job.unroutable",
        data: {
          repository: "cabal/app",
          runId: 9_000 + (run += 1),
          runAttempt: 1,
          workflow: "CI",
          job: "relay",
          reason,
          walk: walk as never,
        },
        occurredAt,
      });
    const offline = {
      step: null,
      skipped: [
        { key: "machine", reason: "no_machine" },
        { key: "github", reason: "not_configured" },
      ],
      notInOrder: [],
      machine: ["self-hosted"],
      github: [],
    };
    await failed(workspace.id, at(HOUR), offline);
    await failed(workspace.id, at(HOUR), offline);
    await failed(
      workspace.id,
      at(3 * HOUR),
      null,
      "No runner available: this GitHub App installation is suspended.",
    );
    await failed(ours.id, at(HOUR), offline);

    let jobId = 70_000;
    const machineJob = (createdAt: Date, startedAt: Date | null, labels = ["rr-0123456789ab"]) => ({
      id: (jobId += 1),
      installationId: workspace.installationId,
      repositoryId: 5_000,
      repositoryFullName: "cabal/app",
      runId: jobId,
      runAttempt: 1,
      kind: "job" as const,
      name: "test",
      labels,
      headSha: "abc",
      status: startedAt ? "in_progress" : "queued",
      githubCreatedAt: createdAt,
      startedAt,
    });
    await db.insert(schema.workflowJob).values([
      machineJob(at(2 * HOUR), at(2 * HOUR - MIN)),
      machineJob(at(2 * HOUR), at(2 * HOUR - 10 * MIN)),
      // Still waiting.
      machineJob(at(5 * MIN), null),
      // On GitHub-hosted: not a machine job.
      machineJob(at(HOUR), at(HOUR - 20 * MIN), ["ubuntu-latest"]),
    ]);

    const health = await routingHealth(db, "24h", { now });
    expect(health.from).toBe("2026-11-12T15:00:00.000Z");
    expect(health.buckets).toHaveLength(24);
    expect(health.totals).toEqual({
      relays: 6,
      routed: 1,
      queued: 2,
      unroutable: 3,
      unroutableWorkspaces: 1,
      p95WaitMs: 10 * MIN,
      waitingNow: 1,
      oldestWaitingMs: 5 * MIN,
    });
    expect(health.reasons).toEqual([
      { kind: "routing", provider: "machine", reason: "no_machine", count: 2 },
      { kind: "routing", provider: "github", reason: "not_configured", count: 2 },
      { kind: "setup", provider: null, reason: "install_suspended", count: 1 },
    ]);
    // 12:30 falls in the 12:00 bucket (index 21), 13:30 in 13:00 (22), 14:00 in 14:00 (23).
    expect(health.buckets[21]).toMatchObject({
      routed: 1,
      queued: 1,
      peakWaiting: 2,
      p95WaitMs: 10 * MIN,
    });
    expect(health.buckets[22]).toMatchObject({ unroutable: 2 });
    expect(health.buckets[23]).toMatchObject({ queued: 1, peakWaiting: 1 });
    expect(health.workspaces).toEqual([
      {
        id: workspace.id,
        name: "Cabal",
        slug: "cabal",
        relays: 6,
        queued: 2,
        unroutable: 3,
        p95WaitMs: 10 * MIN,
        topReason: { kind: "routing", provider: "machine", reason: "no_machine" },
      },
    ]);
  });
});
