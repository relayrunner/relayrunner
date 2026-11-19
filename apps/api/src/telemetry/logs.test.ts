import { generateKeyPairSync } from "node:crypto";
import type { WebhookMessage } from "@relayrunner/github-webhooks";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { createDb } from "../db/index.ts";
import type { Env } from "../env.ts";
import * as testing from "../testing.ts";
import { exportJob } from "./export.ts";
import {
  chunks,
  forgetRateLimits,
  handleJobLogBatch,
  HEAD_BYTES,
  type JobLogMessage,
  lineTime,
  logRecords,
  redactor,
  TAIL_BYTES,
} from "./logs.ts";
import { runIds, stepSpanId } from "./spans.ts";

const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const pem = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const queued: { body: JobLogMessage; delaySeconds?: number }[] = [];
let env: Env;

beforeAll(async () => {
  env = await testing.createTestEnv({
    env: {
      PROVIDER_TOKEN_KEY: { get: async () => KEY },
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: { get: async () => pem },
      TELEMETRY_QUEUE: { send: async () => {} } as unknown as Env["TELEMETRY_QUEUE"],
      JOB_LOG_QUEUE: {
        send: async (body: JobLogMessage, options?: { delaySeconds?: number }) => {
          queued.push({ body, delaySeconds: options?.delaySeconds });
        },
      } as unknown as Env["JOB_LOG_QUEUE"],
    },
  });
});

beforeEach(() => forgetRateLimits());

afterEach(() => {
  vi.unstubAllGlobals();
  queued.length = 0;
});

async function owner() {
  const { cookie } = await testing.signIn(env);
  return testing.createWorkspace(env, cookie, "Acme", `acme-${crypto.randomUUID().slice(0, 8)}`);
}

const settings = {
  endpoint: "https://api.honeycomb.io",
  headers: [{ name: "x-honeycomb-team", value: "hc-key-abcd1234" }],
  serviceName: "",
  enabled: false,
  logs: "failed",
};

const save = (cookie: string, body: unknown) =>
  testing.call(env, "/telemetry", cookie, body, "PUT");

const STEPS = [
  {
    name: "Set up job",
    number: 1,
    conclusion: "success",
    startedAt: "2026-11-14T10:00:10Z",
    completedAt: "2026-11-14T10:00:11Z",
  },
  {
    name: "Run tests",
    number: 2,
    conclusion: "failure",
    startedAt: "2026-11-14T10:00:11Z",
    completedAt: "2026-11-14T10:02:00Z",
  },
];

function jobMessage(
  installationId: number,
  conclusion = "failure",
): Extract<WebhookMessage, { event: "workflow_job" }> {
  return {
    deliveryId: "d",
    installationId,
    receivedAt: "2026-11-14T10:02:01Z",
    event: "workflow_job",
    action: "completed",
    repository: { id: 7, fullName: "acme/app" },
    job: {
      id: Math.floor(Math.random() * 1e9),
      runId: 90,
      runAttempt: 1,
      name: "test",
      workflowName: "CI",
      status: "completed",
      conclusion,
      labels: ["ubuntu-latest"],
      headBranch: "main",
      headSha: "abc",
      runnerName: "GitHub Actions 3",
      runnerGroupName: "GitHub Actions",
      createdAt: "2026-11-14T10:00:00Z",
      startedAt: "2026-11-14T10:00:10Z",
      completedAt: "2026-11-14T10:02:00Z",
      steps: STEPS,
    },
  } as Extract<WebhookMessage, { event: "workflow_job" }>;
}

const LOG = [
  "2026-11-14T10:00:10.1234567Z Current runner version: '2.330.0'",
  "2026-11-14T10:00:11.5000000Z ##[group]Run pnpm test",
  "2026-11-14T10:00:12.0000000Z \u001b[31mFAIL\u001b[0m token=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  "2026-11-14T10:01:59.0000000Z ##[error]Process completed with exit code 1.",
].join("\n");

type Sent = { url: string; headers: Headers; body: any };

/** GitHub (token, rate limit, the log) and the endpoint, with what reached the endpoint. */
function stubFetch({
  log = LOG as string | null,
  remaining = 5000,
  endpoint = 200,
}: { log?: string | null; remaining?: number; endpoint?: number | number[] } = {}) {
  const sent: Sent[] = [];
  const statuses = Array.isArray(endpoint) ? [...endpoint] : null;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const { pathname } = new URL(url);
    if (/\/app\/installations\/\d+\/access_tokens$/.test(pathname))
      return Response.json({ token: "t" }, { status: 201 });
    if (pathname === "/rate_limit")
      return Response.json({
        resources: {
          core: { limit: 5000, used: 5000 - remaining, remaining, reset: Date.now() / 1000 + 600 },
        },
      });
    if (pathname.endsWith("/logs") && url.startsWith("https://api.github.com/"))
      return log === null ? new Response("gone", { status: 404 }) : new Response(log);
    const headers = new Headers(init?.headers);
    const raw = init?.body as Uint8Array | string;
    const text =
      headers.get("content-encoding") === "gzip"
        ? await new Response(
            new Blob([raw as Uint8Array<ArrayBuffer>])
              .stream()
              .pipeThrough(new DecompressionStream("gzip")),
          ).text()
        : String(raw);
    sent.push({ url, headers, body: JSON.parse(text) });
    const status = statuses ? (statuses.shift() ?? 200) : (endpoint as number);
    return new Response(status === 200 ? "{}" : "nope", { status });
  });
  return sent;
}

function batchOf(messages: JobLogMessage[]) {
  const acked: number[] = [];
  const batch = {
    queue: "relayrunner-job-logs",
    messages: messages.map((body, i) => ({
      body,
      attempts: 1,
      ack: () => acked.push(i),
      retry: () => {},
    })),
  } as unknown as MessageBatch<JobLogMessage>;
  return { batch, acked };
}

async function queuedLog(conclusion = "failure") {
  const { cookie, workspace } = await owner();
  await save(cookie, settings);
  await exportJob(env, createDb(env.DB), jobMessage(workspace.installationId, conclusion));
  return { cookie, workspace };
}

describe("queueing", () => {
  test("queues failed jobs' logs by default, and every job's when asked", async () => {
    const { cookie, workspace } = await queuedLog();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      body: { workspaceId: workspace.id, installationId: workspace.installationId },
      delaySeconds: 30,
    });

    await exportJob(env, createDb(env.DB), jobMessage(workspace.installationId, "success"));
    expect(queued).toHaveLength(1);

    await save(cookie, { ...settings, logs: "all" });
    await exportJob(env, createDb(env.DB), jobMessage(workspace.installationId, "success"));
    expect(queued).toHaveLength(2);

    await save(cookie, { ...settings, logs: "off" });
    await exportJob(env, createDb(env.DB), jobMessage(workspace.installationId));
    expect(queued).toHaveLength(2);
  });

  test("a change to which logs go out shows in Activity", async () => {
    const { cookie } = await owner();
    await save(cookie, settings);
    await save(cookie, settings);
    const response = await testing.call(env, "/activity?filter=settings", cookie);
    const { items } = (await response.json()) as { items: { type: string; data: unknown }[] };
    expect(items.filter((item) => item.type === "settings.job_logs")).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ logs: "failed" }) }),
    ]);
  });
});

describe("sending", () => {
  test("sends the log's lines under their steps, redacted", async () => {
    await queuedLog();
    const sent = stubFetch();
    const { batch, acked } = batchOf([queued[0]!.body]);
    queued.length = 0;
    await handleJobLogBatch(batch, env);
    expect(acked).toEqual([0]);
    expect(queued).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://api.honeycomb.io/v1/logs");
    expect(sent[0]!.headers.get("x-honeycomb-team")).toBe("hc-key-abcd1234");

    const [resourceLogs] = sent[0]!.body.resourceLogs;
    const resource = Object.fromEntries(
      resourceLogs.resource.attributes.map((a: any) => [a.key, Object.values(a.value)[0]]),
    );
    expect(resource).toMatchObject({
      "service.name": "github-actions",
      "vcs.repository.name": "acme/app",
      "cicd.pipeline.task.name": "test",
    });
    const records = resourceLogs.scopeLogs[0].logRecords;
    expect(records.map((r: any) => r.body.stringValue)).toEqual([
      "Current runner version: '2.330.0'",
      "##[group]Run pnpm test",
      "FAIL token=[redacted]",
      "##[error]Process completed with exit code 1.",
    ]);
    expect(records[0].timeUnixNano).toBe("1794650410123456700");
    expect(records.map((r: any) => r.severityText)).toEqual(["INFO", "INFO", "INFO", "ERROR"]);

    const jobId = batch.messages[0]!.body.job.id;
    const { traceId } = await runIds(7, 90, 1);
    expect(records[3]).toMatchObject({ traceId, spanId: await stepSpanId(jobId, 2) });
    expect(records[0].spanId).toBe(await stepSpanId(jobId, 1));
  });

  test("waits for a log GitHub doesn't have yet, then gives up on it", async () => {
    const { cookie } = await queuedLog();
    stubFetch({ log: null });
    let message = queued.shift()!.body;
    for (const tries of [1, 2]) {
      await handleJobLogBatch(batchOf([message]).batch, env);
      expect(queued[0]).toMatchObject({ body: { tries }, delaySeconds: 60 });
      message = queued.shift()!.body;
    }
    await handleJobLogBatch(batchOf([message]).batch, env);
    expect(queued).toHaveLength(0);
    const view = await (await testing.call(env, "/telemetry", cookie)).json();
    expect(view).toMatchObject({ logsSkipped: { reason: "GitHub doesn't have the job's log" } });
  });

  test("leaves routing its share of GitHub's API calls", async () => {
    await queuedLog();
    const sent = stubFetch({ remaining: 1000 });
    await handleJobLogBatch(batchOf([queued.shift()!.body]).batch, env);
    expect(sent).toHaveLength(0);
    expect(queued[0]!.delaySeconds).toBeGreaterThanOrEqual(60);
  });

  test("resumes from the request that failed", async () => {
    await queuedLog();
    const big = Array.from(
      { length: 3_000 },
      (_, i) => `2026-11-14T10:00:12.0000000Z line ${i}`,
    ).join("\n");
    const sent = stubFetch({ log: big, endpoint: [200, 503] });
    await handleJobLogBatch(batchOf([queued.shift()!.body]).batch, env);
    expect(sent).toHaveLength(2);
    expect(queued[0]!.body).toMatchObject({ from: 1, tries: 1 });

    const again = stubFetch({ log: big });
    await handleJobLogBatch(batchOf([queued.shift()!.body]).batch, env);
    expect(again).toHaveLength(1);
    expect(again[0]!.body.resourceLogs[0].scopeLogs[0].logRecords[0].body.stringValue).toBe(
      "line 2000",
    );
  });

  test("the test button sends a log line too when logs are on", async () => {
    const { cookie } = await owner();
    await save(cookie, settings);
    const sent = stubFetch();
    const response = await testing.call(env, "/telemetry/test", cookie, {});
    expect(await response.json()).toMatchObject({ sent: { ok: true } });
    expect(sent.map((s) => new URL(s.url).pathname)).toEqual(["/v1/traces", "/v1/logs"]);
  });
});

describe("log lines", () => {
  test("reads GitHub's timestamps to the nanosecond", () => {
    expect(lineTime("2026-11-14T10:00:10.1234567Z hi")).toEqual({
      nanos: "1794650410123456700",
      ms: 1794650410123,
      rest: "hi",
    });
    expect(lineTime("no time")).toBeNull();
  });

  test("hides credentials and private keys", () => {
    const redact = redactor();
    expect(redact("AKIAABCDEFGHIJKLMNOP and xoxb-1234567890-abc")).toBe(
      "[redacted] and [redacted]",
    );
    expect(redact("Authorization: Bearer abcdef.ghijkl")).toBe("Authorization: Bearer [redacted]");
    expect(redact("-----BEGIN RSA PRIVATE KEY-----")).toBe("[redacted]");
    expect(redact("MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo")).toBe("[redacted]");
    expect(redact("-----END RSA PRIVATE KEY-----")).toBe("-----END RSA PRIVATE KEY-----");
    expect(redact("MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo")).toBe(
      "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo",
    );
  });

  test("keeps a long log's start and end, and says what it left out", async () => {
    const line = "x".repeat(1023);
    const count = (HEAD_BYTES + TAIL_BYTES) / 1024 + 100;
    async function* source() {
      for (let i = 0; i < count; i++) yield `2026-11-14T10:00:12.0000000Z ${i} ${line}`;
    }
    const toRecord = await logRecords({
      id: 1,
      runId: 2,
      runAttempt: 1,
      name: "t",
      workflowName: null,
      conclusion: "failure",
      steps: [],
    });
    const bodies: string[] = [];
    for await (const chunk of chunks(source(), toRecord, "https://github.com/job"))
      bodies.push(...chunk.map((record) => record.body));
    const cut = bodies.findIndex((body) => body.includes("left out here"));
    expect(cut).toBeGreaterThan(0);
    expect(bodies[cut]).toContain("https://github.com/job");
    expect(bodies.at(-1)).toMatch(new RegExp(`^${count - 1} `));
    expect(bodies.length).toBeLessThan(count);
  });
});
