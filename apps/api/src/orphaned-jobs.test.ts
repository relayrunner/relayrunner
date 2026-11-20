import { beforeEach, describe, expect, test, vi } from "vitest";
import { createDb, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import { MAX_ORPHANED, sweepOrphanedJobs } from "./orphaned-jobs.ts";
import { createTestEnv } from "./testing.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;

// The route ids the Router still holds, and the StrandedJobs started, by name.
let held: Set<string>;
let alreadyStarted: Set<string>;
const holds = vi.fn(async (routeId: string, _job: unknown) => held.has(routeId));
const start = vi.fn();
const routerFor = vi.fn((_workspaceId: string) => ({ holds }));

let env: Env;
let now: number;
let nextId: number;

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  held = new Set();
  alreadyStarted = new Set();
  holds.mockClear();
  start.mockClear();
  routerFor.mockClear();
  now = Date.now();
  nextId = 1000;
  const testEnv = await createTestEnv();
  for (const query of [
    "insert into github_installation (id, account_id, account_login, account_type, created_at, updated_at) values (7, 10, 'octo', 'User', ?1, ?1)",
    "insert into workspace (id, installation_id, name, slug, created_at) values ('w1', 7, 'W', 'w', ?1)",
  ])
    await testEnv.DB.prepare(query).bind(now).run();
  env = {
    ...testEnv,
    ROUTER: { getByName: routerFor },
    STRANDED_JOB: {
      getByName: (name: string) => ({
        start: async (work: unknown) => {
          start(name, work);
          if (alreadyStarted.has(name)) return false;
          alreadyStarted.add(name);
          return true;
        },
      }),
    },
  } as unknown as Env;
});

const db = () => createDb(env.DB);

// A pick of repo 1's run that answered `label`.
async function pick(runId: number, label: string) {
  await db()
    .insert(schema.routeDecision)
    .values({
      workspaceId: "w1",
      repositoryId: 1,
      runId,
      runAttempt: 1,
      step: "machine",
      runner: label,
      skipped: [],
      notInOrder: [],
      machine: ["self-hosted"],
      github: [],
    });
}

// A job of repo 1 on `labels`, queued `ageMs` ago.
async function queuedJob(
  runId: number,
  labels: string[],
  ageMs: number,
  status: string = "queued",
): Promise<number> {
  const id = ++nextId;
  await db()
    .insert(schema.workflowJob)
    .values({
      id,
      installationId: 7,
      repositoryId: 1,
      repositoryFullName: "octo/app",
      runId,
      runAttempt: 1,
      kind: "job",
      name: "build",
      labels,
      headSha: "abc",
      status,
      githubCreatedAt: new Date(now - ageMs),
    });
  return id;
}

describe("sweepOrphanedJobs", () => {
  test("ends a job still queued on our label that the Router lost track of", async () => {
    await pick(9, "rr-aaaaaaaaaaaa");
    const id = await queuedJob(9, ["rr-aaaaaaaaaaaa"], 20 * MIN);
    const counts = await sweepOrphanedJobs(env, now);
    expect(routerFor).toHaveBeenCalledWith("w1");
    expect(holds).toHaveBeenCalledWith("aaaaaaaaaaaa", { jobId: id, repositoryId: 1, runId: 9 });
    expect(start).toHaveBeenCalledExactlyOnceWith(`aaaaaaaaaaaa:${id}`, {
      routeId: "aaaaaaaaaaaa",
      jobId: id,
      installationId: 7,
      repo: "octo/app",
      reason: "orphaned",
    });
    expect(counts).toMatchObject({ ended: 1 });
    // The next sweep finds it started already: not ended or logged again.
    expect(await sweepOrphanedJobs(env, now)).toMatchObject({ ended: 0, skipped: 1 });
  });

  test("leaves a job the Router holds, such as one waiting for a full machine", async () => {
    await pick(9, "rr-bbbbbbbbbbbb");
    await queuedJob(9, ["rr-bbbbbbbbbbbb"], 2 * HOUR);
    held.add("bbbbbbbbbbbb");
    expect(await sweepOrphanedJobs(env, now)).toMatchObject({ held: 1, ended: 0 });
    expect(start).not.toHaveBeenCalled();
  });

  test("leaves a label no pick of the job's run answered", async () => {
    // Run 9's label copied into run 10, and a label no pick answered at all.
    await pick(9, "rr-cccccccccccc");
    await queuedJob(10, ["rr-cccccccccccc"], 20 * MIN);
    await queuedJob(9, ["rr-dddddddddddd"], 20 * MIN);
    expect(await sweepOrphanedJobs(env, now)).toMatchObject({ not_ours: 2, ended: 0 });
    expect(holds).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  test("leaves jobs too young or too old, not queued, or not on a single route label", async () => {
    await pick(9, "rr-aaaaaaaaaaaa");
    await pick(9, "rr-bbbbbbbbbbbb");
    await queuedJob(9, ["rr-aaaaaaaaaaaa"], 5 * MIN);
    await queuedJob(9, ["rr-aaaaaaaaaaaa"], 25 * HOUR);
    await queuedJob(9, ["rr-aaaaaaaaaaaa"], 20 * MIN, "in_progress");
    await queuedJob(9, ["ubuntu-latest"], 20 * MIN);
    await queuedJob(9, ["rr-aaaaaaaaaaaa", "rr-bbbbbbbbbbbb"], 20 * MIN);
    const counts = await sweepOrphanedJobs(env, now);
    expect(counts).toMatchObject({ ended: 0, skipped: 1 });
    expect(start).not.toHaveBeenCalled();
  });

  test("looks at no more than MAX_ORPHANED jobs, newest first", async () => {
    await pick(9, "rr-aaaaaaaaaaaa");
    const ids: number[] = [];
    for (let i = 0; i < MAX_ORPHANED + 5; i++)
      ids.push(await queuedJob(9, ["rr-aaaaaaaaaaaa"], 20 * MIN + i * 1000));
    const counts = await sweepOrphanedJobs(env, now);
    expect(counts.ended).toBe(MAX_ORPHANED);
    expect(start).toHaveBeenCalledTimes(MAX_ORPHANED);
    const ended = new Set(start.mock.calls.map(([, work]) => (work as { jobId: number }).jobId));
    // The oldest five wait for the next sweep.
    for (const id of ids.slice(-5)) expect(ended.has(id)).toBe(false);
  });
});
