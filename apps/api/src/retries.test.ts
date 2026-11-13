import type { WebhookMessage } from "@relayrunner/github-webhooks";
import { DEFAULT_RETRY_SETTINGS } from "@relayrunner/runner-order";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { createDb, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import {
  classifyFailure,
  effectiveSettings,
  lostRunner,
  retryFailedRun,
  retryOf,
  type FailedJob,
} from "./retries.ts";
import * as testing from "./testing.ts";

vi.mock("./github-app.ts", async (original) => ({
  ...(await original<typeof import("./github-app.ts")>()),
  appInstallationToken: async () => "ghs_test",
}));

afterEach(() => vi.unstubAllGlobals());

const MINUTE = 60_000;
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * MINUTE);

describe("classifyFailure", () => {
  const job = (rest: Partial<FailedJob> = {}): FailedJob => ({
    id: 1,
    name: "test",
    ranSteps: true,
    machineId: null,
    startedAt: at(10),
    completedAt: at(5),
    ...rest,
  });

  test("a job that never got to its steps failed on its runner", () => {
    expect(classifyFailure(job({ ranSteps: false }), [])).toBe("runner_start");
  });

  test("a machine that went offline while its job ran dropped it", () => {
    const onMachine = job({ machineId: "m1" });
    expect(classifyFailure(onMachine, [at(7)])).toBe("machine_lost");
    // GitHub can fail the job just before the disconnect reaches the API.
    expect(classifyFailure(onMachine, [at(4)])).toBe("machine_lost");
    expect(classifyFailure(onMachine, [at(12)])).toBeNull();
    expect(classifyFailure(onMachine, [at(1)])).toBeNull();
  });

  test("a failing step is never the runner's fault", () => {
    expect(classifyFailure(job(), [])).toBeNull();
    // Unknown steps (an older webhook) say nothing either way.
    expect(classifyFailure(job({ ranSteps: null }), [])).toBeNull();
  });
});

test("lostRunner reads GitHub's annotations", () => {
  expect(
    lostRunner([
      "The self-hosted runner: rr-1 lost communication with the server. Verify the machine is running.",
    ]),
  ).toBe(true);
  expect(lostRunner(["The runner has received a shutdown signal."])).toBe(true);
  expect(lostRunner(["Process completed with exit code 1."])).toBe(false);
});

describe("effectiveSettings", () => {
  const on = { enabled: true, runner: "other", max: 2 } as const;

  test("a repo without `retry` follows the workspace", () => {
    expect(effectiveSettings(on, null)).toEqual(on);
    expect(effectiveSettings(DEFAULT_RETRY_SETTINGS, null).enabled).toBe(false);
  });

  test("`retry: false` turns it off for the repo", () => {
    expect(effectiveSettings(on, false).enabled).toBe(false);
  });

  test("`retry` turns it on for the repo and overrides the workspace", () => {
    expect(effectiveSettings(DEFAULT_RETRY_SETTINGS, {})).toEqual({
      ...DEFAULT_RETRY_SETTINGS,
      enabled: true,
    });
    expect(effectiveSettings(on, { runner: "same" })).toEqual({ ...on, runner: "same" });
  });
});

describe("retryFailedRun", () => {
  let env: Env;
  let workspaces = 0;
  let ids = 900_000;

  beforeAll(async () => {
    env = await testing.createTestEnv();
  });

  async function setup(settings: object | null = { enabled: true, runner: "other", max: 1 }) {
    workspaces += 1;
    const { cookie } = await testing.signIn(env);
    const { workspace } = await testing.createWorkspace(
      env,
      cookie,
      `Retries ${workspaces}`,
      `retries-${workspaces}`,
    );
    const installationId = 9100 + workspaces;
    const db = createDb(env.DB);
    await db.insert(schema.githubInstallation).values({
      id: installationId,
      accountId: installationId,
      accountLogin: `retries-org-${workspaces}`,
      accountType: "Organization",
    });
    await testing.useInstallation(env, workspace.id, installationId);
    if (settings)
      await db
        .update(schema.workspace)
        .set({ retrySettings: JSON.stringify(settings) })
        .where(eq(schema.workspace.id, workspace.id));
    return { workspaceId: workspace.id, installationId, repositoryId: installationId * 10 };
  }

  type Setup = Awaited<ReturnType<typeof setup>>;

  // Each run's jobs as GitHub's jobs API lists them.
  const githubJobs = new Map<number, object[]>();

  // A run whose relay routed `test` to `ubuntu-latest`, and `test` failed.
  async function failedRun(
    { workspaceId, installationId, repositoryId }: Setup,
    test: { ranSteps: boolean; labels?: string[] } = { ranSteps: false },
  ) {
    ids += 10;
    const runId = ids;
    const db = createDb(env.DB);
    const base = {
      installationId,
      repositoryId,
      repositoryFullName: "acme/app",
      runId,
      runAttempt: 1,
      workflowName: "CI",
      headSha: "abc",
      status: "completed",
      githubCreatedAt: at(20),
      startedAt: at(15),
      completedAt: at(10),
    };
    // Only the relay is in the jobs table: the failed job's own webhook may not have landed yet.
    await db.insert(schema.workflowJob).values({
      ...base,
      id: runId + 1,
      kind: "pick",
      name: "relay",
      labels: ["relayrunner"],
      conclusion: "success",
    });
    const steps = [
      { name: "Set up job", started_at: at(15).toISOString(), conclusion: "failure" },
      ...(test.ranSteps
        ? [{ name: "Run tests", started_at: at(14).toISOString(), conclusion: "failure" }]
        : []),
    ];
    githubJobs.set(runId, [
      {
        id: runId + 1,
        name: "relay / RelayRunner",
        run_attempt: 1,
        conclusion: "success",
        labels: ["relayrunner"],
      },
      {
        id: runId + 2,
        name: "test",
        run_attempt: 1,
        conclusion: "failure",
        labels: test.labels ?? ["ubuntu-latest"],
        started_at: at(15).toISOString(),
        completed_at: at(10).toISOString(),
        steps,
      },
    ]);
    await db.insert(schema.routeDecision).values({
      workspaceId,
      repositoryId,
      runId,
      runAttempt: 1,
      step: "github",
      runner: "ubuntu-latest",
      skipped: [],
      notInOrder: [],
      machine: [],
      github: ["ubuntu-latest"],
    });
    return runId;
  }

  function completed(
    { installationId, repositoryId }: Setup,
    runId: number,
    run: Partial<Extract<WebhookMessage, { event: "workflow_run" }>["run"]> = {},
  ): Extract<WebhookMessage, { event: "workflow_run" }> {
    return {
      event: "workflow_run",
      deliveryId: `d-${runId}`,
      action: "completed",
      installationId,
      receivedAt: new Date().toISOString(),
      repository: { id: repositoryId, fullName: "acme/app" },
      run: {
        id: runId,
        runAttempt: 1,
        workflowName: "CI",
        displayTitle: "fix: things",
        event: "push",
        actorLogin: "zach",
        startedBy: { id: 2, login: "zach" },
        triggeredBy: { id: 2, login: "zach" },
        headBranch: "main",
        headSha: "abc",
        pullRequestNumber: null,
        status: "completed",
        conclusion: "failure",
        htmlUrl: `https://github.com/acme/app/actions/runs/${runId}`,
        runStartedAt: at(20).toISOString(),
        updatedAt: at(9).toISOString(),
        ...run,
      },
    };
  }

  // GitHub: no relayrunner.yml (or `config`), the re-run answers `rerun`, annotations `annotations`.
  function stubGithub({
    config = null,
    rerun = 201,
    annotations = [],
  }: { config?: string | null; rerun?: number; annotations?: string[] } = {}) {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
        if (url.includes("/contents/"))
          return config === null || !url.endsWith(".github/relayrunner.yml")
            ? new Response("", { status: 404 })
            : new Response(config);
        if (url.endsWith("/rerun"))
          return rerun < 300
            ? new Response(null, { status: rerun })
            : Response.json({ message: "The workflow run is already running" }, { status: rerun });
        const jobs = /\/actions\/runs\/(\d+)\/attempts\/\d+\/jobs/.exec(url);
        if (jobs) return Response.json({ jobs: githubJobs.get(Number(jobs[1])) ?? [] });
        if (url.includes("/annotations"))
          return Response.json(annotations.map((message) => ({ message })));
        return new Response("", { status: 404 });
      }),
    );
    return calls;
  }

  const retries = (runId: number) =>
    createDb(env.DB).select().from(schema.jobRetry).where(eq(schema.jobRetry.runId, runId));

  test("re-runs the relay once when the runner never started the job", async () => {
    const ws = await setup();
    const runId = await failedRun(ws);
    const calls = stubGithub();
    await retryFailedRun(env, completed(ws, runId));
    expect(calls).toContain(`POST /repos/acme/app/actions/jobs/${runId + 1}/rerun`);
    const [record] = await retries(runId);
    expect(record).toMatchObject({
      jobId: runId + 2,
      relayJobId: runId + 1,
      kind: "runner_start",
      runner: "other",
      failedStep: "github",
      status: "requested",
      triggeredById: 2,
    });
    const [event] = await createDb(env.DB)
      .select()
      .from(schema.activityEvent)
      .where(
        and(
          eq(schema.activityEvent.workspaceId, ws.workspaceId),
          eq(schema.activityEvent.type, "job.retried"),
        ),
      );
    expect(event?.data).toMatchObject({
      job: "test",
      kind: "runner_start",
      failedOn: "ubuntu-latest",
    });

    // A redelivered webhook finds the record and asks GitHub nothing.
    const again = stubGithub();
    await retryFailedRun(env, completed(ws, runId));
    expect(again.filter((call) => call.startsWith("POST"))).toEqual([]);

    // The retry's pick sees where the job failed and who started the attempt it retried.
    const db = createDb(env.DB);
    expect(await retryOf(db, ws.repositoryId, runId, 2)).toEqual({
      runner: "other",
      failedStep: "github",
      failedMachineId: null,
      triggeredBy: { id: 2, login: "zach" },
    });
    expect(await retryOf(db, ws.repositoryId, runId, 1)).toBeNull();
    expect(await retryOf(db, ws.repositoryId, runId, 3)).toBeNull();
  });

  test("stops at the run's cap", async () => {
    const ws = await setup();
    const runId = await failedRun(ws);
    stubGithub();
    await retryFailedRun(env, completed(ws, runId));
    // The retried attempt failed the same way: max is 1, so it stays failed.
    githubJobs.set(
      runId,
      githubJobs.get(runId)!.map((job) => ({ ...job, run_attempt: 2 })),
    );
    const calls = stubGithub();
    await retryFailedRun(env, completed(ws, runId, { runAttempt: 2 }));
    expect(calls.filter((call) => call.startsWith("POST"))).toEqual([]);
    expect(await retries(runId)).toHaveLength(1);
  });

  test("leaves a job whose own steps failed", async () => {
    const ws = await setup();
    const runId = await failedRun(ws, { ranSteps: true });
    const calls = stubGithub({ annotations: ["Process completed with exit code 1."] });
    await retryFailedRun(env, completed(ws, runId));
    expect(calls.filter((call) => call.startsWith("POST"))).toEqual([]);
    expect(await retries(runId)).toEqual([]);
  });

  test("retries a job GitHub says lost its runner", async () => {
    const ws = await setup();
    const runId = await failedRun(ws, { ranSteps: true });
    stubGithub({ annotations: ["The runner has received a shutdown signal."] });
    await retryFailedRun(env, completed(ws, runId));
    expect((await retries(runId))[0]).toMatchObject({ kind: "runner_lost", status: "requested" });
  });

  test("does nothing while retries are off, unless the repo turns them on", async () => {
    const ws = await setup(null);
    const off = await failedRun(ws);
    stubGithub();
    await retryFailedRun(env, completed(ws, off));
    expect(await retries(off)).toEqual([]);

    const on = await failedRun(ws);
    stubGithub({ config: "retry:\n  runner: same\n" });
    await retryFailedRun(env, completed(ws, on));
    expect((await retries(on))[0]).toMatchObject({ runner: "same", status: "requested" });
  });

  test("keeps a refused re-run as failed, so it isn't asked again", async () => {
    const ws = await setup();
    const runId = await failedRun(ws);
    stubGithub({ rerun: 403 });
    await retryFailedRun(env, completed(ws, runId));
    const [record] = await retries(runId);
    expect(record).toMatchObject({ status: "failed" });
    expect(record?.error).toContain("403");
    expect(await retryOf(createDb(env.DB), ws.repositoryId, runId, 2)).toBeNull();
  });

  test("ignores jobs the relay didn't route and runs that didn't fail", async () => {
    const ws = await setup();
    const other = await failedRun(ws, { ranSteps: false, labels: ["self-hosted"] });
    const calls = stubGithub();
    await retryFailedRun(env, completed(ws, other));
    const passed = await failedRun(ws);
    await retryFailedRun(env, completed(ws, passed, { conclusion: "success" }));
    expect(calls.filter((call) => call.startsWith("POST"))).toEqual([]);
  });
});
