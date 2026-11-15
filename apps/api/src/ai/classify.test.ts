import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Env } from "../env.ts";
import * as testing from "../testing.ts";
import { aiCacheKey, classify, defineClassifier } from "./classify.ts";
import { purgeExpiredAiAnswers } from "../retention.ts";
import { AI_DEFAULTS, forgetAiSettings, saveAiSettings } from "./settings.ts";
import { createDb } from "../db/index.ts";

const jobType = defineClassifier({
  feature: "job_type",
  version: 1,
  questions: {
    kind: {
      type: "choice",
      instructions: "What does this job do?",
      criteria: { lint: "Lint or format", test: "Tests" },
    },
    short: { type: "noul", instructions: "Will it finish in under a minute?" },
  },
  state: (job: { name: string; id: number }) => ({ name: job.name }),
  cacheKey: (job) => job.name,
});

const answers = {
  kind: {
    type: "choice",
    choice: "lint",
    confidence: 0.9,
    probabilities: { lint: 0.95, test: 0.05 },
  },
  short: { type: "noul", noul: 0.8 },
};

let env: Env;
let workspaceId: string;
let run: ReturnType<typeof vi.fn>;
const NOW = Date.UTC(2026, 10, 15, 12);

async function enable(
  global: Partial<typeof AI_DEFAULTS> = {},
  workspace: { features?: string[] | null; dailyTokens?: number | null } = {},
) {
  const op = await testing.signInOperator(env);
  await saveAiSettings(
    createDb(env.DB),
    { ...AI_DEFAULTS, enabled: true, features: ["job_type", "failure_cause"], ...global },
    op.user.id,
  );
  await env.DB.prepare(
    "insert or replace into workspace_ai_setting (workspace_id, enabled, features, daily_tokens, updated_at) values (?, 1, ?, ?, ?)",
  )
    .bind(
      workspaceId,
      workspace.features ? JSON.stringify(workspace.features) : null,
      workspace.dailyTokens ?? null,
      NOW,
    )
    .run();
  forgetAiSettings();
}

const usage = () =>
  env.DB.prepare("select * from ai_usage_day where workspace_id = ?").bind(workspaceId).first();

beforeEach(async () => {
  run = vi.fn(async () => ({
    model: "jev-1.14.0",
    answers,
    usage: { input_tokens: 400, output_tokens: 20 },
  }));
  env = await testing.createTestEnv({ env: { AI: { run } as unknown as Ai } });
  const { cookie } = await testing.signIn(env);
  ({
    workspace: { id: workspaceId },
  } = await testing.createWorkspace(env, cookie, "Acme", "acme"));
  // Each test starts from a fresh database, so drop settings another isolate cached.
  await saveAiSettings(createDb(env.DB), AI_DEFAULTS, (await testing.signIn(env)).user.id);
});

describe("classify", () => {
  test("is off until both the global switch and the workspace are on", async () => {
    expect(await classify(env, jobType, workspaceId, { name: "lint", id: 1 }, NOW)).toEqual({
      ok: false,
      reason: "off",
    });
    const op = await testing.signInOperator(env);
    await saveAiSettings(
      createDb(env.DB),
      { ...AI_DEFAULTS, enabled: true, features: ["job_type"] },
      op.user.id,
    );
    expect((await classify(env, jobType, workspaceId, { name: "lint", id: 1 }, NOW)).ok).toBe(
      false,
    );
    expect(run).not.toHaveBeenCalled();
  });

  test("is off without the binding", async () => {
    await enable();
    const { AI: _, ...rest } = env;
    expect(await classify(rest as Env, jobType, workspaceId, { name: "lint", id: 1 }, NOW)).toEqual(
      {
        ok: false,
        reason: "off",
      },
    );
  });

  test("respects feature flags globally and per workspace", async () => {
    await enable({ features: ["failure_cause"] });
    expect((await classify(env, jobType, workspaceId, { name: "lint", id: 1 }, NOW)).ok).toBe(
      false,
    );
    await enable({}, { features: ["failure_cause"] });
    expect((await classify(env, jobType, workspaceId, { name: "lint", id: 1 }, NOW)).ok).toBe(
      false,
    );
    expect(run).not.toHaveBeenCalled();
  });

  test("calls the model through the gateway, then answers repeats from the cache", async () => {
    await enable();
    const first = await classify(env, jobType, workspaceId, { name: "lint", id: 1 }, NOW);
    expect(first).toEqual({ ok: true, answers, cached: false });
    if (first.ok) expect(first.answers.kind.choice).toBe("lint");
    expect(run).toHaveBeenCalledWith(
      "typesafe/jev-1.14.0",
      { state: { name: "lint" }, questions: jobType.questions },
      expect.objectContaining({
        gateway: expect.objectContaining({
          id: "relayrunner-ai-gateway",
          metadata: { workspace: workspaceId, feature: "job_type" },
        }),
      }),
    );
    // Another job with the same name is the same question.
    const second = await classify(env, jobType, workspaceId, { name: "lint", id: 2 }, NOW);
    expect(second).toEqual({ ok: true, answers, cached: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(await usage()).toMatchObject({
      calls: 1,
      cache_hits: 1,
      input_tokens: 400,
      output_tokens: 20,
    });
  });

  test("stops at the workspace's daily budget, and starts again the next day", async () => {
    await enable({}, { dailyTokens: 500 });
    await classify(env, jobType, workspaceId, { name: "a", id: 1 }, NOW);
    await classify(env, jobType, workspaceId, { name: "b", id: 2 }, NOW);
    expect(await classify(env, jobType, workspaceId, { name: "c", id: 3 }, NOW)).toEqual({
      ok: false,
      reason: "budget",
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(await usage()).toMatchObject({ calls: 2, limited: 1 });
    expect(
      (await classify(env, jobType, workspaceId, { name: "c", id: 3 }, NOW + 86_400_000)).ok,
    ).toBe(true);
  });

  test("stops at the global daily budget", async () => {
    await enable({ dailyTokens: 100 });
    await classify(env, jobType, workspaceId, { name: "a", id: 1 }, NOW);
    expect((await classify(env, jobType, workspaceId, { name: "b", id: 2 }, NOW)).ok).toBe(false);
  });

  test("stops at the rate limit", async () => {
    await enable();
    const limited = { ...env, AI_LIMITER: { limit: async () => ({ success: false }) } } as Env;
    expect(await classify(limited, jobType, workspaceId, { name: "a", id: 1 }, NOW)).toEqual({
      ok: false,
      reason: "rate_limited",
    });
  });

  test("fails without throwing when the model errors or answers in another shape", async () => {
    await enable();
    run.mockRejectedValueOnce(new Error("gateway timeout"));
    expect(await classify(env, jobType, workspaceId, { name: "a", id: 1 }, NOW)).toEqual({
      ok: false,
      reason: "failed",
    });
    run.mockResolvedValueOnce({ answers: { kind: answers.kind }, usage: { input_tokens: 10 } });
    expect(await classify(env, jobType, workspaceId, { name: "a", id: 1 }, NOW)).toEqual({
      ok: false,
      reason: "failed",
    });
    expect(await usage()).toMatchObject({ failures: 2, input_tokens: 10, calls: 0 });
  });

  test("purges expired answers", async () => {
    await enable();
    await classify(env, jobType, workspaceId, { name: "a", id: 1 }, NOW);
    await purgeExpiredAiAnswers(createDb(env.DB), NOW + 31 * 86_400_000);
    const left = await env.DB.prepare("select count(*) as n from ai_cache").first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});

describe("aiCacheKey", () => {
  test("ignores object key order", async () => {
    expect(await aiCacheKey({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(
      await aiCacheKey({ b: [1, { d: 3, c: 2 }], a: 1 }),
    );
    expect(await aiCacheKey({ a: 1 })).not.toBe(await aiCacheKey({ a: 2 }));
  });
});
