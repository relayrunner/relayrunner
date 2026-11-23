import { beforeAll, describe, expect, test } from "vitest";
import { createDb, schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import { moveReason, routeOutcomes } from "./route-outcomes.ts";
import * as testing from "../testing.ts";
import { DAY_MS } from "../time.ts";

let env: Env;

beforeAll(async () => {
  env = await testing.createTestEnv();
});

const DAY = DAY_MS;
let runIds = 70_000;

type Decision = typeof schema.routeDecision.$inferInsert;

function decision(workspaceId: string, createdAt: number, row: Partial<Decision> = {}): Decision {
  runIds += 1;
  return {
    workspaceId,
    repositoryId: 1,
    runId: runIds,
    runAttempt: 1,
    step: "machine",
    runner: "rr-abc",
    skipped: [],
    notInOrder: [],
    machine: ["macos"],
    github: ["ubuntu-latest"],
    createdAt: new Date(createdAt),
    ...row,
  };
}

describe("route outcomes", () => {
  test("moves on only for skips that change from run to run", () => {
    expect(moveReason([{ reason: "not_configured" }, { reason: "public_repo" }])).toBeNull();
    expect(moveReason([{ reason: "not_configured" }, { reason: "machine_full" }])).toBe("machines");
    expect(moveReason([{ reason: "spend_limit" }, { reason: "provider_unhealthy" }])).toBe("limit");
  });

  test("counts each run's outcome a day at a time", async () => {
    const { cookie } = await testing.signIn(env);
    const { workspace } = await testing.createWorkspace(env, cookie, "Outcomes", "outcomes");
    const db = createDb(env.DB);
    // Three UTC days back, so the API's window still reaches it.
    const origin = Math.floor(Date.now() / DAY) * DAY - 3 * DAY;
    const id = workspace.id;
    await db.insert(schema.routeDecision).values([
      decision(id, origin + 3_600_000),
      decision(id, origin + 7_200_000, {
        step: "github",
        runner: "ubuntu-latest",
        skipped: [{ key: "machine", reason: "machine_full" }],
      }),
      decision(id, origin + DAY + 3_600_000, {
        step: "github",
        runner: "ubuntu-latest",
        skipped: [{ key: "machine", reason: "not_configured" }],
      }),
      decision(id, origin + DAY + 7_200_000, { waitedAt: new Date(origin + DAY + 7_200_000) }),
      decision(id, origin + 2 * DAY + 3_600_000, {
        step: null,
        runner: null,
        skipped: [{ key: "github", reason: "minutes_limit" }],
        reason: "nothing fits",
      }),
      decision(id, origin + 2 * DAY + 7_200_000, {
        step: "blacksmith",
        runner: "blacksmith-4vcpu-ubuntu-2404",
        skipped: [{ key: "github", reason: "minutes_runway" }],
      }),
      // Before the window.
      decision(id, origin - 3_600_000),
    ]);

    const body = await routeOutcomes(db, id, { from: origin, to: origin + 2.5 * DAY });
    expect(body).toMatchObject({ runs: 6, first: 2, movedOn: 2, waited: 1, failed: 1 });
    expect(body.reasons).toEqual([
      { reason: "machines", count: 1 },
      { reason: "limit", count: 1 },
    ]);
    expect(body.buckets.map(({ start, ...counts }) => [start - origin, counts])).toEqual([
      [0, { first: 1, movedOn: 1, waited: 0, failed: 0 }],
      [DAY, { first: 1, movedOn: 0, waited: 1, failed: 0 }],
      [2 * DAY, { first: 0, movedOn: 1, waited: 0, failed: 1 }],
    ]);

    // Over the API, as a member reads it.
    const res = await testing.call(
      env,
      `/workspaces/${id}/route-outcomes?from=${origin}&to=${origin + 2.5 * DAY}&origin=${origin}`,
      cookie,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ runs: 6, bucketMs: DAY });
  });
});
