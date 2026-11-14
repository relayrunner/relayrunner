import type { WebhookMessage } from "@relayrunner/github-webhooks";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { createDb, schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import * as testing from "../testing.ts";
import {
  exportJob,
  exportRun,
  handleTelemetryBatch,
  type TelemetryMessage,
  tracesUrl,
} from "./export.ts";

const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const queued: TelemetryMessage[] = [];
let env: Env;

beforeAll(async () => {
  env = await testing.createTestEnv({
    env: {
      PROVIDER_TOKEN_KEY: { get: async () => KEY },
      TELEMETRY_QUEUE: {
        send: async (body: TelemetryMessage) => {
          queued.push(body);
        },
      } as unknown as Env["TELEMETRY_QUEUE"],
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  queued.length = 0;
});

async function owner() {
  const { cookie } = await testing.signIn(env);
  return testing.createWorkspace(env, cookie, "Acme", `acme-${crypto.randomUUID().slice(0, 8)}`);
}

const save = (cookie: string, body: unknown) =>
  testing.call(env, "/telemetry", cookie, body, "PUT");

const settings = {
  endpoint: "https://api.honeycomb.io/",
  headers: [{ name: "x-honeycomb-team", value: "hc-key-abcd1234" }],
  serviceName: "",
  enabled: true,
};

type Sent = { url: string; headers: Headers; body: any };

function stubEndpoint(status = 200) {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });
    return new Response(status === 200 ? "{}" : "nope", { status });
  });
  return sent;
}

function jobMessage(installationId: number): Extract<WebhookMessage, { event: "workflow_job" }> {
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
      name: "build",
      workflowName: "CI",
      status: "completed",
      conclusion: "success",
      labels: ["ubuntu-latest"],
      headBranch: "main",
      headSha: "abc",
      runnerName: "GitHub Actions 3",
      runnerGroupName: "GitHub Actions",
      createdAt: "2026-11-14T10:00:00Z",
      startedAt: "2026-11-14T10:00:10Z",
      completedAt: "2026-11-14T10:02:00Z",
      steps: [],
    },
  } as Extract<WebhookMessage, { event: "workflow_job" }>;
}

function batchOf(messages: TelemetryMessage[]) {
  const acked: number[] = [];
  const retried: number[] = [];
  const batch = {
    queue: "relayrunner-telemetry",
    messages: messages.map((body, i) => ({
      body,
      attempts: 1,
      ack: () => acked.push(i),
      retry: () => retried.push(i),
    })),
  } as unknown as MessageBatch<TelemetryMessage>;
  return { batch, acked, retried };
}

describe("telemetry settings", () => {
  test("save, and header values never come back", async () => {
    const { cookie } = await owner();
    const empty = await testing.call(env, "/telemetry", cookie);
    expect(await empty.json()).toMatchObject({ configured: false, serviceName: "github-actions" });

    const saved = await save(cookie, settings);
    expect(saved.status).toBe(200);
    const view = await saved.json();
    expect(view).toMatchObject({
      configured: true,
      endpoint: "https://api.honeycomb.io",
      headers: [{ name: "x-honeycomb-team", hint: "1234" }],
      serviceName: "github-actions",
      enabled: true,
    });
    expect(JSON.stringify(view)).not.toContain("hc-key");

    // A header left blank keeps its saved value.
    const kept = await save(cookie, { ...settings, headers: [{ name: "x-honeycomb-team" }] });
    expect(((await kept.json()) as { headers: unknown }).headers).toEqual([
      { name: "x-honeycomb-team", hint: "1234" },
    ]);
    const missing = await save(cookie, { ...settings, headers: [{ name: "x-other" }] });
    expect(await missing.json()).toMatchObject({ error: "missing_header_value" });
  });

  test("refuses endpoints it shouldn't call", async () => {
    const { cookie } = await owner();
    for (const endpoint of [
      "http://api.honeycomb.io",
      "https://10.0.0.1",
      "https://localhost:4318",
      "https://user:pass@example.com",
      "https://api.relayrunner.app",
    ]) {
      const response = await save(cookie, { ...settings, endpoint });
      expect(await response.json(), endpoint).toMatchObject({ error: "invalid_endpoint" });
    }
  });

  test("members can look but not change it", async () => {
    const { workspace } = await owner();
    const member = await testing.joinWorkspace(env, workspace.id, "member");
    expect((await testing.call(env, "/telemetry", member.cookie)).status).toBe(200);
    expect((await save(member.cookie, settings)).status).toBe(403);
  });

  test("the test button sends a trace with the saved headers", async () => {
    const { cookie } = await owner();
    await save(cookie, settings);
    const sent = stubEndpoint();
    const response = await testing.call(env, "/telemetry/test", cookie, {});
    expect(await response.json()).toMatchObject({ sent: { ok: true } });
    expect(sent[0]!.url).toBe("https://api.honeycomb.io/v1/traces");
    expect(sent[0]!.headers.get("x-honeycomb-team")).toBe("hc-key-abcd1234");
    expect(sent[0]!.body.resourceSpans[0].scopeSpans[0].spans).toHaveLength(2);
  });
});

describe("exporting", () => {
  test("queues a finished job only for workspaces with an export on", async () => {
    const { cookie, workspace } = await owner();
    const db = createDb(env.DB);
    await exportJob(env, db, jobMessage(workspace.installationId));
    expect(queued).toHaveLength(0);

    await save(cookie, settings);
    await exportJob(env, db, jobMessage(workspace.installationId));
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      workspaceId: workspace.id,
      resource: { "vcs.repository.name": "acme/app" },
    });
    expect(queued[0]!.spans.map((s) => s.name)).toEqual(["build", "Waiting for a runner"]);
    expect(queued[0]!.spans[0]!.attributes["relayrunner.provider"]).toBe("github");

    // A job still running isn't exported yet.
    const running = jobMessage(workspace.installationId);
    running.job.status = "in_progress";
    await exportJob(env, db, running);
    expect(queued).toHaveLength(1);
  });

  test("queues a finished run's root span", async () => {
    const { cookie, workspace } = await owner();
    await save(cookie, settings);
    await exportRun(env, createDb(env.DB), {
      deliveryId: "d",
      installationId: workspace.installationId,
      receivedAt: "2026-11-14T10:03:00Z",
      event: "workflow_run",
      action: "completed",
      repository: { id: 7, fullName: "acme/app" },
      run: {
        id: 90,
        runAttempt: 1,
        workflowName: "CI",
        displayTitle: "Fix",
        event: "push",
        actorLogin: "octo",
        startedBy: null,
        triggeredBy: null,
        headBranch: "main",
        headSha: "abc",
        pullRequestNumber: null,
        status: "completed",
        conclusion: "success",
        htmlUrl: null,
        runStartedAt: "2026-11-14T10:00:00Z",
        updatedAt: "2026-11-14T10:03:00Z",
      },
    } as Extract<WebhookMessage, { event: "workflow_run" }>);
    expect(queued[0]!.spans[0]).toMatchObject({
      name: "RUN CI",
      attributes: { "relayrunner.routed": false, "relayrunner.retry": false },
    });
  });

  test("sends one request per workspace and acks it", async () => {
    const { cookie, workspace } = await owner();
    await save(cookie, settings);
    const sent = stubEndpoint();
    const message = (name: string): TelemetryMessage => ({
      workspaceId: workspace.id,
      resource: { "vcs.repository.name": "acme/app" },
      spans: [
        {
          traceId: "0".repeat(32),
          spanId: "1".repeat(16),
          name,
          kind: "internal",
          start: 1,
          end: 2,
          attributes: {},
        },
      ],
    });
    const { batch, acked, retried } = batchOf([message("a"), message("b")]);
    await handleTelemetryBatch(batch, env);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.resourceSpans).toHaveLength(2);
    expect(sent[0]!.body.resourceSpans[0].resource.attributes).toContainEqual({
      key: "service.name",
      value: { stringValue: "github-actions" },
    });
    expect(acked).toEqual([0, 1]);
    expect(retried).toEqual([]);
  });

  test("retries a 503, drops a 401, and pauses after days of failures", async () => {
    const { cookie, workspace } = await owner();
    await save(cookie, settings);
    const message: TelemetryMessage = { workspaceId: workspace.id, resource: {}, spans: [] };
    const db = createDb(env.DB);
    const row = async () =>
      (
        await db
          .select()
          .from(schema.telemetryExport)
          .where(eq(schema.telemetryExport.workspaceId, workspace.id))
      )[0]!;

    stubEndpoint(503);
    let result = batchOf([message]);
    await handleTelemetryBatch(result.batch, env);
    expect(result.retried).toEqual([0]);
    expect((await row()).error).toContain("503");

    stubEndpoint(401);
    result = batchOf([message]);
    await handleTelemetryBatch(result.batch, env);
    expect(result.acked).toEqual([0]);
    expect((await row()).enabled).toBe(true);

    await db
      .update(schema.telemetryExport)
      .set({ failingSince: new Date(Date.now() - 4 * 86_400_000) })
      .where(eq(schema.telemetryExport.workspaceId, workspace.id));
    await handleTelemetryBatch(batchOf([message]).batch, env);
    expect(await row()).toMatchObject({ enabled: false, pausedAt: expect.any(Date) });

    // Once paused, queued spans are dropped without a request.
    const sent = stubEndpoint();
    result = batchOf([message]);
    await handleTelemetryBatch(result.batch, env);
    expect(sent).toHaveLength(0);
    expect(result.acked).toEqual([0]);
  });

  test("traces go to /v1/traces once", () => {
    expect(tracesUrl("https://api.honeycomb.io")).toBe("https://api.honeycomb.io/v1/traces");
    expect(tracesUrl("https://x.grafana.net/otlp/")).toBe("https://x.grafana.net/otlp/v1/traces");
    expect(tracesUrl("https://api.axiom.co/v1/traces")).toBe("https://api.axiom.co/v1/traces");
  });
});
