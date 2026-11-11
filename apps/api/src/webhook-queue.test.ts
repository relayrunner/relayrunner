import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { WEBHOOK_DLQ, WEBHOOK_QUEUE, type WebhookMessage } from "@relayrunner/github-webhooks";
import type { Env } from "./env.ts";
import { recordJobTiming } from "./job-timings.ts";
import { recordWorkflowJob, setJobMachine } from "./jobs.ts";
import { startD1 } from "./testing.ts";
import * as consumer from "./webhook-queue.ts";

// Storage is covered against a real D1 in jobs.test.ts and job-timings.test.ts.
vi.mock("./jobs.ts", () => ({
  recordWorkflowJob: vi.fn(async () => true),
  setJobMachine: vi.fn(async () => {}),
}));
vi.mock("./job-timings.ts", () => ({ recordJobTiming: vi.fn(async () => true) }));

const start = vi.fn();
const getByName = vi.fn(() => ({ start }));
const env = { PICK_RUNNER: { getByName }, DB: {} } as unknown as Env;

function message(body: WebhookMessage, attempts = 1) {
  return { body, attempts, ack: vi.fn(), retry: vi.fn() };
}

function batch(queue: string, messages: ReturnType<typeof message>[]) {
  return { queue, messages } as unknown as MessageBatch<WebhookMessage>;
}

const installation: WebhookMessage = {
  event: "installation",
  deliveryId: "d-1",
  action: "created",
  installationId: 7,
  receivedAt: new Date().toISOString(),
  installation: null,
  repositories: [],
};
const malformed = {
  ...installation,
  event: "workflow_job",
  deliveryId: "d-2",
} as unknown as WebhookMessage; // no repository/job

function workflowJob(labels: string[], action = "queued"): WebhookMessage {
  return {
    event: "workflow_job",
    deliveryId: "d-3",
    action,
    installationId: 7,
    receivedAt: new Date().toISOString(),
    repository: { id: 1, fullName: "relayrunner/relayrunner" },
    job: {
      id: 42,
      runId: 9,
      runAttempt: 1,
      name: "pick",
      workflowName: "RelayRunner dev",
      status: action,
      conclusion: null,
      labels,
      headBranch: "main",
      headSha: "abc",
      runnerName: null,
      createdAt: new Date().toISOString(),
    },
  };
}

describe("webhook queue consumer", () => {
  test("acks a processed message", async () => {
    const msg = message(installation);
    await consumer.handleWebhookBatch(batch(WEBHOOK_QUEUE, [msg]), env);
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
  });

  test("retries only the failing message, with backoff", async () => {
    const good = message(installation);
    const bad = message(malformed, 3);
    await consumer.handleWebhookBatch(batch(WEBHOOK_QUEUE, [bad, good]), env);
    expect(bad.retry).toHaveBeenCalledWith({ delaySeconds: 120 });
    expect(bad.ack).not.toHaveBeenCalled();
    expect(good.ack).toHaveBeenCalledOnce();
  });

  test("archives dead letters without processing them", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const put = vi.fn(async () => null);
    const dlqEnv = {
      ...env,
      DEAD_LETTERS: { get: vi.fn(async () => null), put },
    } as unknown as Env;
    const msg = message(malformed, 7);
    await consumer.handleWebhookBatch(batch(WEBHOOK_DLQ, [msg]), dlqEnv);
    expect(put).toHaveBeenCalledOnce();
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
    expect(JSON.parse(error.mock.calls[0][0])).toMatchObject({
      msg: "github webhook dead-lettered",
      deliveryId: "d-2",
    });
    error.mockRestore();
  });

  test("logs workflow jobs that ask for relayrunner", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await consumer.processWebhook(env, workflowJob(["RelayRunner"]));
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
      msg: "relayrunner job received",
      action: "queued",
      installationId: 7,
      repository: "relayrunner/relayrunner",
      jobId: 42,
      labels: ["RelayRunner"],
    });
    log.mockRestore();
  });

  test("hands other runners' jobs to storage without waking a pick runner", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    start.mockClear();
    vi.mocked(recordWorkflowJob).mockClear();
    vi.mocked(recordJobTiming).mockClear();
    await consumer.processWebhook(env, workflowJob(["ubuntu-latest"]));
    expect(recordWorkflowJob).toHaveBeenCalledWith(expect.anything(), expect.anything(), false);
    // Its timing is kept from the start, for the Runs page while it runs and the usage report once
    // it finishes, even though RelayRunner didn't route it.
    expect(recordJobTiming).toHaveBeenCalledOnce();
    await consumer.processWebhook(env, workflowJob(["ubuntu-latest"], "completed"));
    expect(recordJobTiming).toHaveBeenCalledTimes(2);
    expect(log).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    log.mockRestore();
  });

  test("wakes a pick runner, keyed by job id, only when a relayrunner job is queued", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    start.mockClear();
    await consumer.processWebhook(env, workflowJob(["relayrunner"]));
    expect(getByName).toHaveBeenLastCalledWith("42");
    expect(start).toHaveBeenCalledWith({
      jobId: 42,
      installationId: 7,
      repo: "relayrunner/relayrunner",
    });
    await consumer.processWebhook(env, workflowJob(["relayrunner"], "in_progress"));
    expect(start).toHaveBeenCalledOnce();
    log.mockRestore();
  });

  test("only logs Checks App deliveries, even ones the main App acts on", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    start.mockClear();
    vi.mocked(recordWorkflowJob).mockClear();
    await consumer.processWebhook(env, { ...workflowJob(["relayrunner"]), app: "checks" });
    expect(recordWorkflowJob).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
      msg: "checks app webhook received",
      event: "workflow_job",
      repository: "relayrunner/relayrunner",
    });
    log.mockRestore();
  });

  test("starts a container runner for a queued relayrunner-container job from an allowed org", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const startContainer = vi.fn();
    const containers = vi.fn(() => ({ start: startContainer }));
    const withContainers = (orgs?: string) =>
      ({
        ...env,
        CONTAINER_RUNNER: { getByName: containers },
        CONTAINER_RUNNER_ORGS: orgs,
      }) as unknown as Env;
    await consumer.processWebhook(
      withContainers("RelayRunner"),
      workflowJob(["Relayrunner-Container"]),
    );
    expect(containers).toHaveBeenLastCalledWith("42");
    expect(startContainer).toHaveBeenCalledWith({
      jobId: 42,
      installationId: 7,
      repo: "relayrunner/relayrunner",
    });
    // Later actions, orgs outside the allowlist and an unset allowlist start nothing.
    await consumer.processWebhook(
      withContainers("relayrunner"),
      workflowJob(["relayrunner-container"], "in_progress"),
    );
    await consumer.processWebhook(
      withContainers("other-org"),
      workflowJob(["relayrunner-container"]),
    );
    await consumer.processWebhook(withContainers(), workflowJob(["relayrunner-container"]));
    expect(startContainer).toHaveBeenCalledOnce();
    log.mockRestore();
  });

  describe("route jobs", () => {
    let stop: () => Promise<void>;
    let db: D1Database;
    const claim = vi.fn();
    const machineFor = vi.fn(async () => null);
    const run = vi.fn(async () => "sent");
    const claimRunner = vi.fn();
    const releaseRunnerJob = vi.fn();
    const routeEnv = () =>
      ({
        DB: db,
        ROUTER: {
          getByName: vi.fn(() => ({ claim, machineFor, claimRunner, releaseRunnerJob })),
        },
        MACHINE_LINK: { getByName: vi.fn(() => ({ run })) },
      }) as unknown as Env;

    beforeAll(async () => {
      const { proxy, env } = await startD1();
      stop = () => proxy.dispose();
      db = env.DB;
      const now = Date.now();
      await db
        .prepare("insert into workspace (id, name, slug, created_at) values ('w1', 'W', 'w', ?)")
        .bind(now)
        .run();
      await db
        .prepare(
          "insert into github_installation (id, workspace_id, account_id, account_login, account_type, created_at, updated_at) values (7, 'w1', 10, 'relayrunner', 'Organization', ?, ?)",
        )
        .bind(now, now)
        .run();
      await db
        .prepare(
          "insert into machine (id, workspace_id, name, os, source, installation_id, github_runner_id, routing_label, created_at, updated_at) values ('gh1', 'w1', 'atticus-mac-mini', 'macos', 'github', 7, 11, 'rr-runner-0a1b2c3d', ?, ?)",
        )
        .bind(now, now)
        .run();
    });
    afterAll(() => stop());

    test("a job on an added runner's label claims the route without minting a runner", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      vi.mocked(setJobMachine).mockClear();
      claimRunner.mockResolvedValueOnce({ id: "0123456789ab", machineId: "gh1" });
      run.mockClear();
      const env = routeEnv();
      await consumer.processWebhook(env, workflowJob(["RR-RUNNER-0a1b2c3d"]));
      expect(claimRunner).toHaveBeenCalledWith("gh1", { jobId: 42, repositoryId: 1, runId: 9 });
      expect(run).not.toHaveBeenCalled();
      expect(setJobMachine).toHaveBeenCalledWith(expect.anything(), 42, "gh1");
      // Once it starts, the route ends: the runner's own busy status takes over.
      releaseRunnerJob.mockResolvedValueOnce("gh1");
      await consumer.processWebhook(env, workflowJob(["rr-runner-0a1b2c3d"], "in_progress"));
      expect(releaseRunnerJob).toHaveBeenCalledWith("gh1", {
        jobId: 42,
        repositoryId: 1,
        runId: 9,
      });
      expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({ result: "tracked" });
      log.mockRestore();
    });

    test("an unknown runner label is left alone", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      claimRunner.mockClear();
      await consumer.processWebhook(routeEnv(), workflowJob(["rr-runner-ffffffff"]));
      expect(claimRunner).not.toHaveBeenCalled();
      expect(JSON.parse(warn.mock.calls[0][0])).toMatchObject({ result: "no_machine" });
      warn.mockRestore();
    });

    test("a queued rr-<id> job claims its route and goes to the route's machine", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const route = { id: "0123456789ab", machineId: "m1" };
      claim.mockResolvedValueOnce(route);
      const env = routeEnv();
      await consumer.processWebhook(env, workflowJob(["rr-0123456789ab"]));
      expect(env.ROUTER.getByName).toHaveBeenCalledWith("w1");
      expect(claim).toHaveBeenCalledWith("0123456789ab", { jobId: 42, repositoryId: 1, runId: 9 });
      expect(env.MACHINE_LINK.getByName).toHaveBeenCalledWith("m1");
      expect(run).toHaveBeenCalledWith({ route, workspaceId: "w1" });
      expect(setJobMachine).toHaveBeenCalledWith(expect.anything(), 42, "m1");
      expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({ result: "sent" });
      log.mockRestore();
    });

    test("an unknown or mismatched route gets nothing, and only queued jobs claim", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      claim.mockReset().mockResolvedValue(null);
      run.mockClear();
      const env = routeEnv();
      await consumer.processWebhook(env, workflowJob(["rr-0123456789ab"]));
      expect(JSON.parse(warn.mock.calls[0][0])).toMatchObject({ result: "no_route" });
      claim.mockClear();
      await consumer.processWebhook(env, workflowJob(["rr-0123456789ab"], "in_progress"));
      expect(claim).not.toHaveBeenCalled();
      expect(machineFor).toHaveBeenCalledWith("0123456789ab", {
        jobId: 42,
        repositoryId: 1,
        runId: 9,
      });
      expect(run).not.toHaveBeenCalled();
      warn.mockRestore();
      log.mockRestore();
    });
  });

  test("backs off from 30 seconds up to 15 minutes", () => {
    expect([1, 2, 3, 6, 10].map(consumer.retryDelaySeconds)).toEqual([30, 60, 120, 900, 900]);
  });
});
