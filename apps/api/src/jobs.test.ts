import type { WebhookMessage, WorkflowJob } from "@relayrunner/github-webhooks";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createDb, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import type { ActivityPage } from "@relayrunner/activity";
import * as testing from "./testing.ts";
import { processWebhook } from "./webhook-queue.ts";
import { runningJobs } from "./jobs.ts";
import { recordPick } from "./route-decisions.ts";
import { decideRoute } from "./routing.ts";

let proxy: Awaited<ReturnType<typeof testing.startD1>>["proxy"];
let env: Env;
const start = vi.fn();
// The Router and MachineLink Durable Objects, reduced to what a route job's webhooks call.
const claim = vi.fn();
const machineFor = vi.fn();
const run = vi.fn(async () => "sent");

beforeAll(async () => {
  let d1Env: Env;
  ({ proxy, env: d1Env } = await testing.startD1());
  env = {
    ...d1Env,
    PICK_RUNNER: { getByName: () => ({ start }) },
    ROUTER: { getByName: () => ({ claim, machineFor }) },
    MACHINE_LINK: { getByName: () => ({ run }) },
  } as unknown as Env;
}, 60_000);

afterAll(async () => {
  await proxy?.dispose();
});

let ids = 0;

// A signed-in owner of a fresh workspace with one connected installation.
async function connectedWorkspace() {
  ids += 1;
  const { cookie: signedIn } = await testing.signIn(env);
  const { workspace, cookie } = await testing.createWorkspace(
    env,
    signedIn,
    `Jobs ${ids}`,
    `jobs-${ids}`,
  );
  const installationId = 900 + ids;
  await createDb(env.DB)
    .insert(schema.githubInstallation)
    .values({
      id: installationId,
      workspaceId: workspace.id,
      accountId: installationId,
      accountLogin: `org-${ids}`,
      accountType: "Organization",
    });
  return { cookie, installationId, workspaceId: workspace.id, runId: 7000 + ids * 10 };
}

function jobEvent(
  installationId: number,
  job: Partial<WorkflowJob> & Pick<WorkflowJob, "id" | "runId" | "name" | "labels">,
  action = "queued",
): WebhookMessage {
  return {
    event: "workflow_job",
    deliveryId: `d-${job.id}-${action}`,
    action,
    installationId,
    receivedAt: new Date().toISOString(),
    repository: { id: 55, fullName: "relayrunner/relayrunner-ci-tests" },
    job: {
      runAttempt: 1,
      workflowName: "RelayRunner dev",
      status: action,
      conclusion: null,
      headBranch: "main",
      headSha: "abc123",
      runnerName: null,
      createdAt: "2026-11-04T18:00:00Z",
      ...job,
    },
  };
}

// The routed jobs in a page of the Activity log.
async function activity(cookie: string, query = "") {
  const res = await testing.call(env, `/activity${query}`, cookie);
  expect(res.status).toBe(200);
  const page = (await res.json()) as ActivityPage;
  return {
    items: page.items,
    jobs: page.items.flatMap((item) => (item.type === "job.routed" && item.job ? [item.job] : [])),
    nextBefore: page.nextBefore,
  };
}

// What a pick in `runId` knew when it answered.
function pickContext(runId: number, runAttempt = 1) {
  return {
    repo: "relayrunner/relayrunner-ci-tests",
    runId,
    runAttempt,
    workflow: "RelayRunner dev",
    machine: ["macOS"],
    github: ["ubuntu-latest"],
    blacksmith: [],
  };
}

describe("Activity: why a job ran where", () => {
  test("a routed job carries its run's walk down the runner order", async () => {
    const { cookie, installationId, workspaceId, runId } = await connectedWorkspace();
    const context = pickContext(runId);
    const decision = await decideRoute(
      { steps: [{ key: "machine" }, { key: "github" }] },
      { ...context, private: true },
      async () => null,
    );
    await recordPick(createDb(env.DB), {
      workspaceId,
      repositoryId: 55,
      context,
      jobName: "relay",
      decision,
      reason: null,
    });
    // A redelivered pick keeps the first decision.
    await recordPick(createDb(env.DB), {
      workspaceId,
      repositoryId: 55,
      context,
      jobName: "relay",
      decision: { ...decision, skipped: [] },
      reason: null,
    });
    await processWebhook(
      env,
      jobEvent(installationId, { id: runId + 1, runId, name: "pick", labels: ["relayrunner"] }),
    );
    await processWebhook(
      env,
      jobEvent(installationId, { id: runId + 2, runId, name: "test", labels: ["ubuntu-latest"] }),
    );
    // A re-run of failed jobs reuses attempt 1's pick.
    await processWebhook(
      env,
      jobEvent(installationId, {
        id: runId + 3,
        runId,
        runAttempt: 2,
        name: "lint",
        labels: ["ubuntu-latest"],
      }),
    );

    const walk = {
      step: "github",
      skipped: [{ key: "machine", reason: "no_machine" }],
      notInOrder: [],
      machine: ["macOS"],
      github: ["ubuntu-latest"],
      blacksmith: [],
    };
    const { jobs } = await activity(cookie);
    expect(jobs.map((job) => [job.name, job.walk])).toEqual([
      ["lint", walk],
      ["test", walk],
    ]);
  });

  test("a job from before decisions were kept has no walk", async () => {
    const { cookie, installationId, runId } = await connectedWorkspace();
    await processWebhook(
      env,
      jobEvent(installationId, { id: runId + 1, runId, name: "pick", labels: ["relayrunner"] }),
    );
    await processWebhook(
      env,
      jobEvent(installationId, { id: runId + 2, runId, name: "test", labels: ["ubuntu-latest"] }),
    );
    expect((await activity(cookie)).jobs[0].walk).toBeNull();
  });

  test("a relay that couldn't route is logged with its reason", async () => {
    const { cookie, workspaceId, runId } = await connectedWorkspace();
    const context = pickContext(runId);
    const decision = await decideRoute(
      { steps: [{ key: "machine" }] },
      { ...context, private: true },
      async () => null,
    );
    if (decision.runner !== null) throw new Error("expected no runner");
    await recordPick(createDb(env.DB), {
      workspaceId,
      repositoryId: 55,
      context,
      jobName: "relay",
      decision,
      reason: decision.reason,
    });
    // RelayRunner can't see the repo: no walk, still logged.
    await recordPick(createDb(env.DB), {
      workspaceId,
      repositoryId: null,
      context: { ...pickContext(runId + 1), repo: "relayrunner/hidden" },
      jobName: "relay",
      decision: null,
      reason: "No runner available: RelayRunner doesn't have access to relayrunner/hidden.",
    });

    const { items } = await activity(cookie, "?filter=job");
    expect(items).toMatchObject([
      {
        type: "job.unroutable",
        job: null,
        data: { repository: "relayrunner/hidden", walk: null },
      },
      {
        type: "job.unroutable",
        job: null,
        data: {
          repository: "relayrunner/relayrunner-ci-tests",
          runId,
          runAttempt: 1,
          workflow: "RelayRunner dev",
          job: "relay",
          reason:
            "No runner available: no self-hosted machine with macOS is online and idle; GitHub-hosted isn't in your runner order.",
          walk: {
            step: null,
            skipped: [{ key: "machine", reason: "no_machine" }],
            notInOrder: ["github"],
          },
        },
      },
    ]);
  });
});

describe("Activity: jobs that couldn't run", () => {
  // A relay in `runId` that failed fast, then GitHub skipping the jobs that needed it.
  async function failedRun(installationId: number, workspaceId: string, runId: number) {
    const context = pickContext(runId);
    const decision = await decideRoute(
      { steps: [{ key: "machine" }] },
      { ...context, private: true },
      async () => null,
    );
    if (decision.runner !== null) throw new Error("expected no runner");
    await processWebhook(
      env,
      jobEvent(installationId, { id: runId + 1, runId, name: "relay", labels: ["relayrunner"] }),
    );
    await recordPick(createDb(env.DB), {
      workspaceId,
      repositoryId: 55,
      context,
      jobName: "relay",
      decision,
      reason: decision.reason,
    });
  }

  function skipped(installationId: number, runId: number, id: number, name: string) {
    return processWebhook(
      env,
      jobEvent(
        installationId,
        {
          id,
          runId,
          name,
          labels: [],
          conclusion: "skipped",
          createdAt: `2026-11-04T18:0${id % 10}:00Z`,
        },
        "completed",
      ),
    );
  }

  test("folds the skipped jobs into the relay's entry", async () => {
    const { cookie, installationId, workspaceId, runId } = await connectedWorkspace();
    await failedRun(installationId, workspaceId, runId);
    expect((await activity(cookie)).items).toMatchObject([
      { type: "job.unroutable", jobsNotRun: [] },
    ]);

    await skipped(installationId, runId, runId + 2, "build");
    await skipped(installationId, runId, runId + 3, "test");
    const { items } = await activity(cookie);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "job.unroutable", jobsNotRun: ["build", "test"] });
  });

  test("keeps a never-routed job's row when its run has no unroutable entry", async () => {
    const { cookie, installationId, runId } = await connectedWorkspace();
    await processWebhook(
      env,
      jobEvent(installationId, { id: runId + 1, runId, name: "relay", labels: ["relayrunner"] }),
    );
    await skipped(installationId, runId, runId + 2, "deploy");
    const { jobs, items } = await activity(cookie);
    expect(items).toHaveLength(1);
    expect(jobs).toMatchObject([{ name: "deploy", conclusion: "skipped", runner: { label: "" } }]);
  });

  test("leaves another attempt's jobs alone", async () => {
    const { cookie, installationId, workspaceId, runId } = await connectedWorkspace();
    await failedRun(installationId, workspaceId, runId);
    await processWebhook(
      env,
      jobEvent(
        installationId,
        { id: runId + 2, runId, runAttempt: 2, name: "build", labels: [], conclusion: "skipped" },
        "completed",
      ),
    );
    const { items } = await activity(cookie);
    expect(items.map((item) => item.type)).toEqual(["job.routed", "job.unroutable"]);
    expect(items[1]).toMatchObject({ jobsNotRun: [] });
  });
});

describe("Activity", () => {
  test("lists the job a pick routed, with the runner it selected", async () => {
    const { cookie, installationId, runId } = await connectedWorkspace();
    const pick = { id: runId + 1, runId, name: "pick", labels: ["relayrunner"] };
    const test = { id: runId + 2, runId, name: "test", labels: ["ubuntu-latest"] };

    await processWebhook(env, jobEvent(installationId, pick));
    // The pick job itself isn't activity.
    expect((await activity(cookie)).jobs).toEqual([]);

    await processWebhook(
      env,
      jobEvent(installationId, { ...pick, runnerName: "relayrunner-pick-1" }, "in_progress"),
    );
    await processWebhook(
      env,
      jobEvent(installationId, { ...pick, conclusion: "success" }, "completed"),
    );
    await processWebhook(env, jobEvent(installationId, test));
    await processWebhook(
      env,
      jobEvent(
        installationId,
        { ...test, runnerName: "GitHub Actions 3", startedAt: "2026-11-04T18:01:00Z" },
        "in_progress",
      ),
    );

    const { jobs } = await activity(cookie);
    expect(jobs).toMatchObject([
      {
        id: test.id,
        workflow: "RelayRunner dev",
        name: "test",
        runner: { type: "github", label: "ubuntu-latest" },
        runnerName: "GitHub Actions 3",
        status: "in_progress",
        repository: "relayrunner/relayrunner-ci-tests",
        startedAt: "2026-11-04T18:01:00.000Z",
        url: `https://github.com/relayrunner/relayrunner-ci-tests/actions/runs/${runId}/job/${test.id}`,
        runUrl: `https://github.com/relayrunner/relayrunner-ci-tests/actions/runs/${runId}`,
      },
    ]);
    // One event for the job, however many webhooks it got.
    expect((await activity(cookie)).items).toHaveLength(1);
  });

  test("shows a job on a Blacksmith label as Blacksmith", async () => {
    const { cookie, installationId, runId } = await connectedWorkspace();
    await processWebhook(
      env,
      jobEvent(installationId, { id: runId + 1, runId, name: "pick", labels: ["relayrunner"] }),
    );
    await processWebhook(
      env,
      jobEvent(installationId, {
        id: runId + 2,
        runId,
        name: "test",
        labels: ["blacksmith-2vcpu-ubuntu-2404"],
      }),
    );
    const { jobs } = await activity(cookie);
    expect(jobs).toMatchObject([
      { name: "test", runner: { type: "blacksmith", label: "blacksmith-2vcpu-ubuntu-2404" } },
    ]);
  });

  test("names the machine a route sent the job to, never the rr- label", async () => {
    const { cookie, installationId, workspaceId, runId } = await connectedWorkspace();
    const machineId = `machine-${runId}`;
    await createDb(env.DB)
      .insert(schema.machine)
      .values({ id: machineId, workspaceId, name: "Atticus's MacBook" });
    await processWebhook(
      env,
      jobEvent(installationId, { id: runId + 1, runId, name: "pick", labels: ["relayrunner"] }),
    );
    const test = { id: runId + 2, runId, name: "test", labels: ["rr-0123456789ab"] };

    // Before the route is claimed, the job is known to be a machine's, but not which one.
    claim.mockResolvedValueOnce(null);
    await processWebhook(env, jobEvent(installationId, test));
    expect((await activity(cookie)).jobs[0].runner).toEqual({
      type: "machine",
      machineId: null,
      name: null,
    });

    // A redelivered `queued` claims the route and hands it to the machine.
    claim.mockResolvedValueOnce({ id: "0123456789ab", machineId });
    await processWebhook(env, jobEvent(installationId, test));
    expect(claim).toHaveBeenLastCalledWith("0123456789ab", {
      jobId: test.id,
      repositoryId: 55,
      runId,
    });
    expect((await activity(cookie)).jobs[0].runner).toEqual({
      type: "machine",
      machineId,
      name: "Atticus's MacBook",
    });
  });

  test("learns a route job's machine from a webhook that beats its `queued`", async () => {
    const { cookie, installationId, workspaceId, runId } = await connectedWorkspace();
    const machineId = `machine-${runId}`;
    await createDb(env.DB)
      .insert(schema.machine)
      .values({ id: machineId, workspaceId, name: "studio" });
    await processWebhook(
      env,
      jobEvent(installationId, { id: runId + 1, runId, name: "pick", labels: ["relayrunner"] }),
    );
    machineFor.mockResolvedValueOnce(machineId);
    await processWebhook(
      env,
      jobEvent(
        installationId,
        {
          id: runId + 2,
          runId,
          name: "test",
          labels: ["rr-0123456789ab"],
          runnerName: "studio-0123456789ab",
        },
        "in_progress",
      ),
    );
    const [job] = (await activity(cookie)).jobs;
    expect(job).toMatchObject({
      status: "in_progress",
      runner: { type: "machine", machineId, name: "studio" },
      runnerName: "studio-0123456789ab",
    });
  });

  test("never rewinds a job when deliveries arrive out of order", async () => {
    const { cookie, installationId, runId } = await connectedWorkspace();
    await processWebhook(
      env,
      jobEvent(installationId, { id: runId + 1, runId, name: "pick", labels: ["relayrunner"] }),
    );
    const test = { id: runId + 2, runId, name: "test", labels: ["ubuntu-latest"] };
    await processWebhook(
      env,
      jobEvent(
        installationId,
        { ...test, conclusion: "success", runnerName: "GitHub Actions 4" },
        "completed",
      ),
    );
    await processWebhook(env, jobEvent(installationId, test, "in_progress"));
    await processWebhook(env, jobEvent(installationId, test, "queued"));

    const [job] = (await activity(cookie)).jobs;
    expect(job).toMatchObject({
      status: "completed",
      conclusion: "success",
      runnerName: "GitHub Actions 4",
    });
  });

  test("ignores jobs from runs with no pick", async () => {
    const { cookie, installationId, runId } = await connectedWorkspace();
    await processWebhook(
      env,
      jobEvent(installationId, { id: runId + 1, runId, name: "lint", labels: ["ubuntu-latest"] }),
    );
    expect((await activity(cookie)).jobs).toEqual([]);
  });

  test("shows only the active workspace's jobs", async () => {
    const mine = await connectedWorkspace();
    const theirs = await connectedWorkspace();
    for (const { installationId, runId } of [mine, theirs]) {
      await processWebhook(
        env,
        jobEvent(installationId, { id: runId + 1, runId, name: "pick", labels: ["relayrunner"] }),
      );
      await processWebhook(
        env,
        jobEvent(installationId, {
          id: runId + 2,
          runId,
          name: "test",
          labels: ["ubuntu-latest"],
        }),
      );
    }
    const { jobs } = await activity(mine.cookie);
    expect(jobs.map((job) => job.id)).toEqual([mine.runId + 2]);
  });

  test("pages with a before cursor", async () => {
    const { cookie, installationId, runId } = await connectedWorkspace();
    await processWebhook(
      env,
      jobEvent(installationId, { id: runId + 1, runId, name: "pick", labels: ["relayrunner"] }),
    );
    for (let i = 0; i < 51; i += 1)
      await processWebhook(
        env,
        jobEvent(installationId, {
          id: runId * 100 + i,
          runId,
          name: `test ${i}`,
          labels: ["ubuntu-latest"],
        }),
      );
    const first = await activity(cookie);
    expect(first.jobs).toHaveLength(50);
    expect(first.jobs[0].name).toBe("test 50");
    expect(first.nextBefore).toBe(first.items[49].id);
    const second = await activity(cookie, `?before=${first.nextBefore}`);
    expect(second.jobs.map((job) => job.name)).toEqual(["test 0"]);
    expect(second.nextBefore).toBeNull();

    for (const query of ["?before=nope", "?filter=repo"]) {
      const bad = await testing.call(env, `/activity${query}`, cookie);
      expect(bad.status).toBe(400);
    }
  });
});

describe("runningJobs", () => {
  test("gives each machine its newest in-progress job, and nothing for idle ones", async () => {
    const { installationId, workspaceId, runId } = await connectedWorkspace();
    const db = createDb(env.DB);
    await db.insert(schema.machine).values([
      { id: `busy-${runId}`, workspaceId, name: "busy" },
      { id: `idle-${runId}`, workspaceId, name: "idle" },
    ]);
    const row = (id: number, status: string, created: number, machineId: string) => ({
      id,
      installationId,
      repositoryId: 55,
      repositoryFullName: "acme/app",
      runId,
      runAttempt: 1,
      kind: "job" as const,
      workflowName: "CI",
      name: `job-${id}`,
      labels: ["rr-0123456789ab"],
      headSha: "abc",
      status,
      machineId,
      githubCreatedAt: new Date(created),
      startedAt: new Date(created + 1000),
    });
    await db.insert(schema.workflowJob).values([
      // A row stuck in_progress from a lost `completed` webhook, older than the real one.
      row(runId + 1, "in_progress", 1_000, `busy-${runId}`),
      row(runId + 2, "in_progress", 5_000, `busy-${runId}`),
      row(runId + 3, "completed", 9_000, `idle-${runId}`),
    ]);

    const jobs = await runningJobs(db, [`busy-${runId}`, `idle-${runId}`]);
    expect(jobs.get(`busy-${runId}`)).toEqual({
      repository: "acme/app",
      workflow: "CI",
      name: `job-${runId + 2}`,
      url: `https://github.com/acme/app/actions/runs/${runId}/job/${runId + 2}`,
      startedAt: new Date(6_000).toISOString(),
    });
    expect(jobs.has(`idle-${runId}`)).toBe(false);
    expect((await runningJobs(db, [])).size).toBe(0);
  });
});
