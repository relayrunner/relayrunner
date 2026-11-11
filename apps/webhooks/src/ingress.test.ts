import { describe, expect, test } from "vitest";
import type { WebhookMessage } from "@relayrunner/github-webhooks";
import { handleRequest, type Env } from "./ingress.ts";

const secret = "test-secret";
const checksSecret = "checks-secret";
const spendSecret = "spend-secret";

class FakeQueue {
  sent: WebhookMessage[] = [];
  fail = false;
  async send(message: WebhookMessage) {
    if (this.fail) throw new Error("queue down");
    this.sent.push(message);
  }
}

function storeSecret(value: string) {
  return { get: async () => value } as SecretsStoreSecret;
}

// What get() does when the store has no secret by that name.
const missingSecret = {
  get: async () => {
    throw new Error("secret not found");
  },
} as SecretsStoreSecret;

async function sign(body: string, signingSecret = secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
  );
  return `sha256=${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function setup(envOverrides: Partial<Env> = {}, path = "/api/webhooks/github") {
  const queue = new FakeQueue();
  const env = {
    GITHUB_WEBHOOK_SECRET: storeSecret(secret),
    GITHUB_CHECK_WEBHOOK_SECRET: storeSecret(checksSecret),
    GITHUB_SPEND_WEBHOOK_SECRET: storeSecret(spendSecret),
    WEBHOOK_QUEUE: queue,
    ...envOverrides,
  } as unknown as Env;
  const post = (body: string, headers: Record<string, string>) =>
    handleRequest(new Request(`https://hooks.test${path}`, { method: "POST", body, headers }), env);
  return { queue, post };
}

const workflowJob = JSON.stringify({
  action: "queued",
  installation: { id: 7 },
  repository: { id: 1, full_name: "acme/app" },
  workflow_job: {
    id: 42,
    run_id: 9,
    run_attempt: 1,
    name: "test",
    workflow_name: "CI",
    status: "queued",
    conclusion: null,
    labels: ["relayrunner"],
    head_branch: "main",
    head_sha: "abc",
    runner_name: null,
    created_at: "2026-11-04T00:00:00Z",
  },
});

describe("webhook ingress", () => {
  test("rejects a missing or wrong signature", async () => {
    const { post, queue } = setup();
    expect((await post("{}", { "x-github-event": "ping" })).status).toBe(401);
    expect(
      (
        await post("{}", {
          "x-github-event": "ping",
          "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
        })
      ).status,
    ).toBe(401);
    expect(queue.sent).toHaveLength(0);
  });

  test("fails loudly when the secret is not configured", async () => {
    const { post } = setup({ GITHUB_WEBHOOK_SECRET: missingSecret });
    expect((await post("{}", { "x-github-event": "ping" })).status).toBe(500);
  });

  test("answers ping with ok and does not enqueue it", async () => {
    const { post, queue } = setup();
    const body = JSON.stringify({ zen: "Keep it logically awesome.", hook_id: 1 });
    const response = await post(body, {
      "x-github-event": "ping",
      "x-hub-signature-256": await sign(body),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(queue.sent).toHaveLength(0);
  });

  test("enqueues a compact message for a signed workflow_job", async () => {
    const { post, queue } = setup();
    const response = await post(workflowJob, {
      "x-github-event": "workflow_job",
      "x-github-delivery": "d-1",
      "x-hub-signature-256": await sign(workflowJob),
    });
    expect(response.status).toBe(202);
    expect(queue.sent).toHaveLength(1);
    expect(queue.sent[0]).toMatchObject({
      event: "workflow_job",
      deliveryId: "d-1",
      action: "queued",
      installationId: 7,
      repository: { fullName: "acme/app" },
      job: { id: 42, labels: ["relayrunner"] },
    });
  });

  test("accepts events it does not act on without enqueueing", async () => {
    const { post, queue } = setup();
    const body = JSON.stringify({ action: "created" });
    const response = await post(body, {
      "x-github-event": "star",
      "x-hub-signature-256": await sign(body),
    });
    expect(response.status).toBe(202);
    expect(queue.sent).toHaveLength(0);
  });

  test("returns 503 when the queue rejects the message", async () => {
    const { post, queue } = setup();
    queue.fail = true;
    const response = await post(workflowJob, {
      "x-github-event": "workflow_job",
      "x-hub-signature-256": await sign(workflowJob),
    });
    expect(response.status).toBe(503);
  });

  test("only answers POST on the webhook path", async () => {
    const { queue } = setup();
    const env = {
      GITHUB_WEBHOOK_SECRET: storeSecret(secret),
      WEBHOOK_QUEUE: queue,
    } as unknown as Env;
    expect(
      (await handleRequest(new Request("https://hooks.test/api/webhooks/github"), env)).status,
    ).toBe(405);
    expect(
      (await handleRequest(new Request("https://hooks.test/other", { method: "POST" }), env))
        .status,
    ).toBe(404);
  });

  describe("Checks App and check suites", () => {
    const checksPath = "/api/webhooks/github-checks";
    const checkSuite = JSON.stringify({
      action: "requested",
      installation: { id: 8 },
      repository: { id: 1, full_name: "acme/app" },
      check_suite: { id: 99, head_sha: "abc", head_branch: "main", pull_requests: [] },
    });

    test("verifies with its own secret, not the main App's", async () => {
      const { post, queue } = setup({}, checksPath);
      const headers = { "x-github-event": "check_suite" };
      expect(
        (await post(checkSuite, { ...headers, "x-hub-signature-256": await sign(checkSuite) }))
          .status,
      ).toBe(401);
      expect(queue.sent).toHaveLength(0);
    });

    test("tags its messages with the app", async () => {
      const { post, queue } = setup({}, checksPath);
      const response = await post(checkSuite, {
        "x-github-event": "check_suite",
        "x-github-delivery": "d-2",
        "x-hub-signature-256": await sign(checkSuite, checksSecret),
      });
      expect(response.status).toBe(202);
      expect(queue.sent).toEqual([
        expect.objectContaining({
          app: "checks",
          event: "check_suite",
          deliveryId: "d-2",
          installationId: 8,
          checkSuite: expect.objectContaining({ id: 99, headSha: "abc" }),
        }),
      ]);
    });

    test("drops check suites sent to the main App", async () => {
      const { post, queue } = setup();
      const response = await post(checkSuite, {
        "x-github-event": "check_suite",
        "x-hub-signature-256": await sign(checkSuite),
      });
      expect(response.status).toBe(202);
      expect(queue.sent).toHaveLength(0);
    });

    test("fails loudly when its secret is not configured", async () => {
      const { post } = setup({ GITHUB_CHECK_WEBHOOK_SECRET: missingSecret }, checksPath);
      expect((await post("{}", { "x-github-event": "ping" })).status).toBe(500);
    });
  });

  test("leaves main App messages untagged", async () => {
    const { post, queue } = setup();
    await post(workflowJob, {
      "x-github-event": "workflow_job",
      "x-hub-signature-256": await sign(workflowJob),
    });
    expect(queue.sent[0].app).toBeUndefined();
  });
});

describe("Spend App", () => {
  const spendPath = "/api/webhooks/github-spend";
  const installed = JSON.stringify({
    action: "created",
    installation: { id: 12, account: { id: 5, login: "acme", type: "Organization" } },
    repositories: [],
  });

  test("queues its installation events, tagged with the app", async () => {
    const { post, queue } = setup({}, spendPath);
    const response = await post(installed, {
      "x-github-event": "installation",
      "x-github-delivery": "d-3",
      "x-hub-signature-256": await sign(installed, spendSecret),
    });
    expect(response.status).toBe(202);
    expect(queue.sent).toEqual([
      expect.objectContaining({ app: "spend", event: "installation", installationId: 12 }),
    ]);
  });

  test("drops any other event", async () => {
    const { post, queue } = setup({}, spendPath);
    const response = await post(workflowJob, {
      "x-github-event": "workflow_job",
      "x-hub-signature-256": await sign(workflowJob, spendSecret),
    });
    expect(response.status).toBe(202);
    expect(queue.sent).toHaveLength(0);
  });
});
