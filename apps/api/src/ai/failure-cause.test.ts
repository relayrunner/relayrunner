import { beforeEach, describe, expect, test, vi } from "vitest";
import { createDb } from "../db/index.ts";
import type { Env } from "../env.ts";
import * as testing from "../testing.ts";
import { failureCauseOf } from "./failure-cause.ts";
import { AI_DEFAULTS, forgetAiSettings, saveAiSettings } from "./settings.ts";

let env: Env;
let workspaceId: string;
let run: ReturnType<typeof vi.fn>;

const failure = (log: string[]) => ({
  name: "test",
  failedStep: "4. Run tests",
  runnerFailed: false,
  annotations: [],
  log,
});

beforeEach(async () => {
  run = vi.fn(async () => ({
    answers: {
      cause: { type: "choice", choice: "flaky", confidence: 0.8, probabilities: { flaky: 0.9 } },
      rerun: { type: "noul", noul: 0.7 },
    },
    usage: { input_tokens: 300, output_tokens: 20 },
  }));
  env = await testing.createTestEnv({ env: { AI: { run } as unknown as Ai } });
  const op = await testing.signInOperator(env);
  ({
    workspace: { id: workspaceId },
  } = await testing.createWorkspace(env, op.cookie, "Acme", "acme"));
  await saveAiSettings(
    createDb(env.DB),
    { ...AI_DEFAULTS, enabled: true, features: ["failure_cause"] },
    op.user.id,
  );
  await env.DB.prepare(
    "insert into workspace_ai_setting (workspace_id, enabled, updated_at) values (?, 1, ?)",
  )
    .bind(workspaceId, Date.now())
    .run();
  forgetAiSettings();
});

describe("failureCauseOf", () => {
  test("names the likely cause and the chance a re-run passes", async () => {
    const cause = await failureCauseOf(env, workspaceId, failure(["##[error]ETIMEDOUT"]));
    expect(cause).toEqual({ kind: "flaky", confidence: 0.8, passesOnRerun: 0.7 });
    const [, input] = run.mock.calls[0]!;
    expect(input.state).toMatchObject({
      failed_step: "4. Run tests",
      log_end: ["##[error]ETIMEDOUT"],
    });
  });

  test("asks once for the same error with different ids and timings", async () => {
    await failureCauseOf(env, workspaceId, failure(["Request a1b2c3d4e5 timed out after 3000ms"]));
    await failureCauseOf(
      env,
      workspaceId,
      failure(["Request ffee99887766 timed out after 2875ms"]),
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("is null with nothing to go on, or when AI is off for the workspace", async () => {
    expect(await failureCauseOf(env, workspaceId, failure([]))).toBeNull();
    expect(await failureCauseOf(env, "another-workspace", failure(["boom"]))).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });
});
