import { relayInputs } from "@relayrunner/runner-order";
import { beforeAll, describe, expect, test } from "vitest";
import { autoPick, relayJobOf } from "./auto-jobs.ts";
import { createDb } from "./db/index.ts";
import type { Env } from "./env.ts";
import type { JobContext } from "./routing.ts";
import * as testing from "./testing.ts";

let env: Env;

beforeAll(async () => {
  env = await testing.createTestEnv();
});

const context = (inputs: Partial<JobContext> = {}): JobContext => ({
  repo: "acme/app",
  runId: 7,
  runAttempt: 1,
  workflow: "CI",
  workflowPath: ".github/workflows/ci.yml",
  startedBy: null,
  triggeredBy: null,
  ...relayInputs(inputs),
});

test("relayJobOf reads the caller's job from the relay's display name", () => {
  expect(relayJobOf("relay-test / RelayRunner")).toBe("relay-test");
  expect(relayJobOf(null)).toBe("relay");
});

describe("auto jobs", () => {
  test("a pick lists the job, and the Router page sizes it", async () => {
    const { cookie } = await testing.signIn(env);
    const { workspace, cookie: jar } = await testing.createWorkspace(env, cookie, "Auto", "auto");
    const db = createDb(env.DB);
    const job = { workspaceId: workspace.id, repositoryId: 1, relayJob: "relay-test" };

    // No size set anywhere: 2 vCPU, every provider when the relay names none.
    const first = await autoPick(db, { ...job, context: context() });
    expect(first.size).toBe(2);
    expect(first.inputs.blacksmith).toEqual(["blacksmith-2vcpu-ubuntu-2404"]);
    expect(first.inputs.github).toEqual(["ubuntu-latest"]);
    expect(first.inputs.machine).toEqual(["self-hosted"]);

    const listed = await testing.call(env, `/workspaces/${workspace.id}/auto-jobs`, jar);
    const body = (await listed.json()) as {
      size: number;
      jobs: { id: number; relayJob: string }[];
    };
    expect(body.size).toBe(2);
    expect(body.jobs.map((each) => each.relayJob)).toEqual(["relay-test"]);

    // The workspace default, then the job's own size and first provider.
    const size = await testing.call(
      env,
      `/workspaces/${workspace.id}/auto-size`,
      jar,
      { size: 4 },
      "PUT",
    );
    expect(size.status).toBe(200);
    expect((await autoPick(db, { ...job, context: context() })).size).toBe(4);

    const saved = await testing.call(
      env,
      `/workspaces/${workspace.id}/auto-jobs/${body.jobs[0].id}`,
      jar,
      { size: 8, first: "blacksmith" },
      "PUT",
    );
    expect(saved.status).toBe(200);
    const sized = await autoPick(db, { ...job, context: context({ blacksmith: ["auto"] }) });
    expect(sized).toEqual({
      size: 8,
      first: "blacksmith",
      inputs: relayInputs({ blacksmith: ["blacksmith-8vcpu-ubuntu-2404"] }),
    });

    const bad = await testing.call(
      env,
      `/workspaces/${workspace.id}/auto-size`,
      jar,
      { size: 3 },
      "PUT",
    );
    expect(bad.status).toBe(400);
    const missing = await testing.call(
      env,
      `/workspaces/${workspace.id}/auto-jobs/999999`,
      jar,
      { size: 8, first: null },
      "PUT",
    );
    expect(missing.status).toBe(404);
  });
});
