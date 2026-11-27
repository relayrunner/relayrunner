import { beforeAll, describe, expect, test } from "vitest";
import { createDb, schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import { reportWaitingRelays, sweepTargets, UNCLAIMED_RELAYS_KEY } from "./pick-sweep.ts";
import { alertLine, takeHealthAlerts } from "../operator/health-issues.ts";
import * as testing from "../testing.ts";

let env: Env;

beforeAll(async () => {
  env = await testing.createTestEnv();
});

const DAY = 24 * 60 * 60_000;

describe("sweepTargets", () => {
  test("sweeps each org, and only repos with a relay in the last day", async () => {
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
      // An org's relay adds its repo too: pick runners register there first.
      job(9301, "acme/web", "pick", 60_000),
    ]);

    const targets = (await sweepTargets(db, now)).filter((target) =>
      [9301, 9302, 9303].includes(target.installationId),
    );
    expect(targets).toHaveLength(3);
    expect(targets).toEqual(
      expect.arrayContaining([
        { installationId: 9301, scope: { kind: "org", org: "acme" } },
        { installationId: 9302, scope: { kind: "repo", repo: "atticoos/app" } },
        { installationId: 9301, scope: { kind: "repo", repo: "acme/web" } },
      ]),
    );
  });
});

describe("reportWaitingRelays", () => {
  test("alerts once two sweeps in a row find relays still unclaimed, and clears when none are", async () => {
    const db = createDb(env.DB);
    const now = Date.UTC(2026, 10, 27, 18, 30);
    const MIN = 60_000;
    const relay = (installationId: number, waitedMin: number) => ({
      installationId,
      queuedAt: new Date(now - waitedMin * MIN),
    });
    // Used-up relays (a runner group that leaves the repo out) never count.
    const sweep = (at: number) =>
      reportWaitingRelays(
        db,
        [
          { job: relay(1, 7), result: "active" },
          { job: relay(2, 22), result: "rescued" },
          { job: relay(3, 600), result: "exhausted" },
        ],
        at,
      );
    await sweep(now);
    expect(await takeHealthAlerts(db, new Date(now))).toEqual([]);
    await sweep(now + 15 * MIN);
    const [alert] = await takeHealthAlerts(db, new Date(now + 15 * MIN));
    expect(alert).toMatchObject({ key: UNCLAIMED_RELAYS_KEY, kind: "relays", state: "failing" });
    expect(alertLine(alert!)).toBe(
      `Relay jobs aren't being claimed (since ${new Date(now).toISOString()}): 2 relay jobs in 2 installations unclaimed for over 5 minutes (oldest 37 minutes)`,
    );
    // Only used-up relays left: nothing waiting, so it clears.
    await reportWaitingRelays(db, [{ job: relay(3, 630), result: "exhausted" }], now + 30 * MIN);
    expect(await takeHealthAlerts(db, new Date(now + 30 * MIN))).toMatchObject([
      { key: UNCLAIMED_RELAYS_KEY, state: "cleared" },
    ]);
  });
});
