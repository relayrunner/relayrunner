import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createDb, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import { sweepTargets } from "./pick-sweep.ts";
import * as testing from "./testing.ts";

let proxy: Awaited<ReturnType<typeof testing.startD1>>["proxy"];
let env: Env;

beforeAll(async () => {
  ({ proxy, env } = await testing.startD1());
}, 60_000);

afterAll(async () => {
  await proxy?.dispose();
});

const DAY = 24 * 60 * 60_000;

describe("sweepTargets", () => {
  test("sweeps each org, and only a personal account's repos with a relay in the last day", async () => {
    const db = createDb(env.DB);
    const now = Date.now();
    await db.insert(schema.githubInstallation).values([
      { id: 9301, accountId: 9301, accountLogin: "acme", accountType: "Organization" },
      { id: 9302, accountId: 9302, accountLogin: "atticoos", accountType: "User" },
      {
        id: 9303,
        accountId: 9303,
        accountLogin: "paused",
        accountType: "User",
        suspendedAt: new Date(now),
      },
    ]);
    let id = 930_000;
    const job = (installationId: number, repo: string, kind: "pick" | "job", ageMs: number) => ({
      id: ++id,
      installationId,
      repositoryId: id,
      repositoryFullName: repo,
      runId: id,
      runAttempt: 1,
      kind,
      name: "relay",
      labels: ["relayrunner"],
      headSha: "abc",
      status: "completed",
      githubCreatedAt: new Date(now - ageMs),
    });
    await db.insert(schema.workflowJob).values([
      // Two relays on one repo: swept once.
      job(9302, "atticoos/app", "pick", 60_000),
      job(9302, "atticoos/app", "pick", 2 * 60_000),
      // Too old to have a pick runner left.
      job(9302, "atticoos/old", "pick", 2 * DAY),
      // Not a relay, so no pick runner registered there.
      job(9302, "atticoos/other", "job", 60_000),
      // A suspended installation isn't swept.
      job(9303, "paused/app", "pick", 60_000),
      // An org's relay doesn't add a repo: the org itself is swept.
      job(9301, "acme/web", "pick", 60_000),
    ]);

    const targets = (await sweepTargets(db, now)).filter((target) =>
      [9301, 9302, 9303].includes(target.installationId),
    );
    expect(targets).toEqual([
      { installationId: 9301, scope: { kind: "org", org: "acme" } },
      { installationId: 9302, scope: { kind: "repo", repo: "atticoos/app" } },
    ]);
  });
});
