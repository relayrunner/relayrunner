import { beforeEach, describe, expect, test, vi } from "vitest";
import { createDb } from "../db/index.ts";
import type { Env } from "../env.ts";
import * as testing from "../testing.ts";
import { failureCauseOf } from "./failure-cause.ts";
import { AI_DEFAULTS, saveAiSettings, setWorkspaceAi } from "./settings.ts";

let env: Env;
let workspaceId: string;
let run: ReturnType<typeof vi.fn>;

const answers = (choice: string, confidence: number, noul: number) => ({
  answers: {
    cause: { type: "choice", choice, confidence, probabilities: { [choice]: confidence } },
    rerun: { type: "noul", noul },
  },
  usage: { input_tokens: 300, output_tokens: 20 },
});

const failure = (log: string[]) => ({
  name: "test",
  failedStep: "4. Run tests",
  runnerFailed: false,
  annotations: [],
  log,
});

beforeEach(async () => {
  run = vi.fn(async () => answers("flaky", 0.8, 0.7));
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
});

describe("failureCauseOf", () => {
  test("names the likely cause and the chance a re-run passes", async () => {
    const cause = await failureCauseOf(env, workspaceId, failure(["##[error]ETIMEDOUT"]));
    expect(cause).toEqual({ kind: "flaky", confidence: 0.8, passesOnRerun: 0.7, rerun: null });
    const [, input] = run.mock.calls[0]!;
    expect(input.state).toMatchObject({
      failed_step: "4. Run tests",
      log_end: ["##[error]ETIMEDOUT"],
    });
  });

  test("says what a re-run will do only when the answers are sure and agree", async () => {
    const errors = ["first", "second", "third", "fourth", "fifth", "sixth"];
    const verdict = async (choice: string, confidence: number, noul: number) => {
      run.mockResolvedValueOnce(answers(choice, confidence, noul));
      // A different error each time, so no answer comes from the cache.
      const cause = await failureCauseOf(env, workspaceId, failure([`${errors.shift()} error`]));
      return cause?.rerun;
    };
    expect(await verdict("flaky", 0.95, 0.9)).toBe("passes");
    expect(await verdict("test", 0.95, 0.05)).toBe("fails");
    // A failed assertion called flaky at 74%: too unsure for a verdict.
    expect(await verdict("flaky", 0.74, 0.9)).toBeNull();
    // The cause and the re-run answer disagree.
    expect(await verdict("test", 0.95, 0.9)).toBeNull();
    // Too unsure to give a cause at all, or the model says so.
    expect(await verdict("lint", 0.6, 0.1)).toBeUndefined();
    expect(await verdict("unclear", 0.95, 0.5)).toBeUndefined();
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
    await setWorkspaceAi(createDb(env.DB), workspaceId, false, null);
    expect(await failureCauseOf(env, workspaceId, failure(["boom"]))).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });
});
