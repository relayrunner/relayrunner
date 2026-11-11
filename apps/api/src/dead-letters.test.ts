import { WEBHOOK_DLQ, WEBHOOK_QUEUE, type WebhookMessage } from "@relayrunner/github-webhooks";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { app } from "./app.ts";
import { checkDeadLetterGrowth } from "./dead-letter-alert.ts";
import { archiveDeadLetter, listDeadLetters, recordLastError } from "./dead-letters.ts";
import type { Env } from "./env.ts";
import { startD1 } from "./testing.ts";
import { accessEnv, accessJwt } from "./testing-access.ts";
import { handleWebhookBatch, MAX_RETRIES } from "./webhook-queue.ts";

function message(deliveryId: string, overrides: Partial<WebhookMessage> = {}): WebhookMessage {
  return {
    event: "repository",
    deliveryId,
    action: "renamed",
    installationId: 7,
    receivedAt: "2026-11-04T00:00:00Z",
    repository: { id: 1, fullName: "acme/app", private: false },
    ...overrides,
  } as WebhookMessage;
}

function queued(body: WebhookMessage, attempts: number) {
  return { body, attempts, ack: vi.fn(), retry: vi.fn() };
}

function batch(queue: string, messages: ReturnType<typeof queued>[]) {
  return { queue, messages } as unknown as MessageBatch<WebhookMessage>;
}

let stop: () => Promise<void>;
let base: Env;
let bucket: R2Bucket;
const send = vi.fn(async () => {});

beforeAll(async () => {
  const { proxy, env } = await startD1();
  stop = () => proxy.dispose();
  bucket = env.DEAD_LETTERS;
  base = {
    ...env,
    ...accessEnv,
    WEBHOOK_QUEUE: { send } as unknown as Queue<WebhookMessage>,
  };
});
afterAll(() => stop());

beforeEach(async () => {
  send.mockClear();
  const { objects } = await bucket.list();
  await Promise.all(objects.map((object) => bucket.delete(object.key)));
});
afterEach(() => vi.restoreAllMocks());

describe("DLQ consumer", () => {
  test("archives a dead letter to R2, then acks it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const msg = queued(message("d-1"), 7);
    await handleWebhookBatch(batch(WEBHOOK_DLQ, [msg]), base);
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
    const day = new Date().toISOString().slice(0, 10);
    const object = await bucket.get(`${day.replaceAll("-", "/")}/d-1.json`);
    expect(await object!.json()).toMatchObject({
      id: `${day}_d-1`,
      deliveryId: "d-1",
      event: "repository",
      action: "renamed",
      repository: "acme/app",
      installationId: 7,
      attempts: 7,
      message: message("d-1"),
    });
  });

  test("leaves the message unacked when the R2 write fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = {
      get: vi.fn(async () => null),
      put: vi.fn(async () => {
        throw new Error("R2 unavailable");
      }),
    } as unknown as R2Bucket;
    const msg = queued(message("d-2"), 1);
    await handleWebhookBatch(batch(WEBHOOK_DLQ, [msg]), { ...base, DEAD_LETTERS: failing });
    expect(msg.ack).not.toHaveBeenCalled();
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
  });

  test("the last processing error lands in the dead letter", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    // No repository or job, so processing throws.
    const bad = { ...message("d-3"), event: "workflow_job" } as unknown as WebhookMessage;
    const early = queued(bad, 1);
    await handleWebhookBatch(batch(WEBHOOK_QUEUE, [early]), base);
    expect((await bucket.list({ prefix: "errors/" })).objects).toHaveLength(0);
    const last = queued(bad, MAX_RETRIES + 1);
    await handleWebhookBatch(batch(WEBHOOK_QUEUE, [last]), base);
    expect(last.retry).toHaveBeenCalled();

    await handleWebhookBatch(batch(WEBHOOK_DLQ, [queued(bad, MAX_RETRIES + 1)]), base);
    const { deadLetters } = await listDeadLetters(bucket);
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]!.lastError).toMatch(/\w/);
    expect((await bucket.list({ prefix: "errors/" })).objects).toHaveLength(0);
  });
});

describe("listDeadLetters", () => {
  test("lists newest first, a day at a time, with a cursor and filters", async () => {
    const now = new Date("2026-11-04T12:00:00Z");
    await archiveDeadLetter(bucket, message("old"), 7, new Date("2026-11-02T08:00:00Z"));
    await archiveDeadLetter(bucket, message("a"), 7, new Date("2026-11-04T09:00:00Z"));
    await archiveDeadLetter(
      bucket,
      message("b", { repository: { id: 2, fullName: "acme/other", private: true } }),
      7,
      new Date("2026-11-04T10:00:00Z"),
    );
    const first = await listDeadLetters(bucket, { now, limit: 1 });
    expect(first.deadLetters.map((letter) => letter.deliveryId)).toEqual(["b", "a"]);
    expect(first.nextCursor).toBe("2026-11-03");
    const second = await listDeadLetters(bucket, { now, cursor: first.nextCursor! });
    expect(second.deadLetters.map((letter) => letter.id)).toEqual(["2026-11-02_old"]);
    const filtered = await listDeadLetters(bucket, { now, filter: { repository: "ACME/other" } });
    expect(filtered.deadLetters.map((letter) => letter.deliveryId)).toEqual(["b"]);
  });
});

describe("/api/admin/webhooks", () => {
  async function call(path: string, init: RequestInit = {}, env: Env = base, token = true) {
    const headers = new Headers(init.headers);
    if (token) headers.set("Cf-Access-Jwt-Assertion", await accessJwt());
    return app.request(`/api/admin/webhooks${path}`, { ...init, headers }, env);
  }

  const routes: [string, string][] = [
    ["GET", "/dead-letters"],
    ["POST", "/dead-letters/replay"],
    ["POST", "/dead-letters/2026-11-04_d-1/replay"],
    ["DELETE", "/dead-letters/2026-11-04_d-1"],
  ];

  test.each(routes)("%s %s answers 404 where Access isn't configured", async (method, path) => {
    const env = { ...base, ACCESS_TEAM_DOMAIN: undefined, ACCESS_AUD: undefined };
    expect((await call(path, { method }, env)).status).toBe(404);
  });

  test.each(routes)("%s %s answers 403 without an Access JWT", async (method, path) => {
    const response = await call(path, { method }, base, false);
    expect(response.status).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });

  test("lists, replays and discards with a valid Access JWT", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const a = await archiveDeadLetter(bucket, message("d-a"), 7);
    const b = await archiveDeadLetter(bucket, message("d-b"), 7);

    const list = await call("/dead-letters");
    expect(list.status).toBe(200);
    const page = (await list.json()) as { deadLetters: { id: string }[] };
    expect(page.deadLetters.map((letter) => letter.id).sort()).toEqual([a.id, b.id].sort());

    // Replay sends the original message, delivery ID and all, back to the main queue.
    const replay = await call(`/dead-letters/${a.id}/replay`, { method: "POST" });
    expect(replay.status).toBe(200);
    expect(send).toHaveBeenCalledWith(message("d-a"), { contentType: "json" });
    expect((await call(`/dead-letters/${a.id}/replay`, { method: "POST" })).status).toBe(404);

    expect((await call(`/dead-letters/${b.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await call(`/dead-letters/${b.id}`, { method: "DELETE" })).status).toBe(404);
    expect(send).toHaveBeenCalledOnce();
    expect((await bucket.list()).objects).toHaveLength(0);
  });

  test("bulk replay needs a filter and replays only what matches", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await archiveDeadLetter(bucket, message("d-x"), 7);
    await archiveDeadLetter(
      bucket,
      message("d-y", { repository: { id: 2, fullName: "acme/other", private: true } }),
      7,
    );
    const json = { "content-type": "application/json" };
    const none = await call("/dead-letters/replay", { method: "POST", headers: json, body: "{}" });
    expect(none.status).toBe(400);
    const some = await call("/dead-letters/replay", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ repository: "acme/other" }),
    });
    expect(await some.json()).toMatchObject({ replayed: [expect.stringMatching(/_d-y$/)] });
    expect(send).toHaveBeenCalledOnce();
    expect((await listDeadLetters(bucket)).deadLetters.map((l) => l.deliveryId)).toEqual(["d-x"]);
  });
});

describe("dead letter growth alert", () => {
  test("alerts at the threshold, and posts to the webhook when one is set", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const post = vi.fn(async () => new Response(null, { status: 204 }));
    const env = {
      ...base,
      DEAD_LETTER_ALERT_THRESHOLD: "2",
      DEAD_LETTER_ALERT_WEBHOOK_URL: "https://hooks.example/alert",
    };
    await recordLastError(bucket, "ignored", { error: "x", attempts: 6, at: "" });
    await archiveDeadLetter(bucket, message("d-1"), 7);
    expect(await checkDeadLetterGrowth(env, new Date(), post)).toEqual({
      count: 1,
      alerted: false,
    });
    await archiveDeadLetter(bucket, message("d-2"), 7);
    expect(await checkDeadLetterGrowth(env, new Date(), post)).toEqual({
      count: 2,
      alerted: true,
    });
    expect(post).toHaveBeenCalledWith("https://hooks.example/alert", expect.anything());
    expect(JSON.parse(error.mock.calls[0]![0])).toMatchObject({
      msg: "webhook dead letters rising",
      count: 2,
    });
  });
});
