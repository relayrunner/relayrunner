import { beforeEach, describe, expect, test, vi } from "vitest";
import { createDb, schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import { jobTimesReport } from "../job-times.ts";
import * as testing from "../testing.ts";
import { classifyJobTypes } from "./job-type.ts";
import { AI_DEFAULTS, forgetAiSettings, saveAiSettings } from "./settings.ts";

let env: Env;
let workspaceId: string;
let installationId: number;
let run: ReturnType<typeof vi.fn>;
let ids = 0;

const kinds: Record<string, string> = { lint: "lint", test: "test", deploy: "deploy" };

async function job(name: string, workflow = "CI") {
  ids += 1;
  const completed = Date.now() - 3_600_000;
  await createDb(env.DB)
    .insert(schema.jobTiming)
    .values({
      id: ids,
      installationId,
      repositoryId: 77,
      repositoryFullName: "acme/app",
      runId: ids,
      runAttempt: 1,
      workflowName: workflow,
      name,
      labels: ["ubuntu-latest"],
      conclusion: "success",
      runnerName: "runner",
      runnerGroupName: "GitHub Actions",
      queuedAt: new Date(completed - 65_000),
      startedAt: new Date(completed - 60_000),
      completedAt: new Date(completed),
    });
}

async function enableAi(on = true) {
  const op = await testing.signInOperator(env);
  await saveAiSettings(
    createDb(env.DB),
    { ...AI_DEFAULTS, enabled: on, features: ["job_type"] },
    op.user.id,
  );
  await env.DB.prepare(
    "insert or replace into workspace_ai_setting (workspace_id, enabled, updated_at) values (?, 1, ?)",
  )
    .bind(workspaceId, Date.now())
    .run();
  forgetAiSettings();
}

beforeEach(async () => {
  run = vi.fn(async (_model: string, input: { state: { job: string } }) => {
    const choice = kinds[input.state.job.split(" ")[0]!] ?? "other";
    return {
      answers: {
        kind: { type: "choice", choice, confidence: 0.9, probabilities: { [choice]: 0.9 } },
      },
      usage: { input_tokens: 150, output_tokens: 10 },
    };
  });
  env = await testing.createTestEnv({ env: { AI: { run } as unknown as Ai } });
  const { cookie } = await testing.signIn(env);
  const { workspace } = await testing.createWorkspace(env, cookie, "Acme", "acme");
  workspaceId = workspace.id;
  installationId = workspace.installationId;
});

describe("classifyJobTypes", () => {
  test("does nothing while AI is off", async () => {
    await job("lint");
    expect(await classifyJobTypes(env, installationId)).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });

  test("classifies each recent job once, matrix legs together, and adds types to job times", async () => {
    await enableAi();
    await job("lint");
    await job("test (node 22)");
    await job("test (node 24)");
    await job("publish", "Release");

    expect(await classifyJobTypes(env, installationId)).toBe(3);
    expect(run).toHaveBeenCalledTimes(3);
    // Already known: no more calls.
    expect(await classifyJobTypes(env, installationId)).toBe(0);
    expect(run).toHaveBeenCalledTimes(3);

    const report = await jobTimesReport(createDb(env.DB), workspaceId, 7);
    const ci = report.workflows.find((w) => w.workflow === "CI")!;
    expect(ci.jobs.find((j) => j.name === "lint")?.type).toBe("lint");
    const test = ci.jobs.find((j) => j.name === "test")!;
    expect(test.type).toBe("test");
    expect(test.legs?.every((leg) => leg.type === "test")).toBe(true);
    expect(report.workflows.find((w) => w.workflow === "Release")?.jobs[0]?.type).toBe("other");
  });
});
