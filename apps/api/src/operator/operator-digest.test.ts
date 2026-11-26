import { recordEvent } from "../ingest/activity-log.ts";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { createDb, schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import {
  buildDigest,
  collectDigest,
  digestContext,
  digestPeriods,
  type DigestCounts,
  formatDigest,
  previousPeriod,
  sendOperatorDigests,
  zoneMidnight,
} from "./operator-digest.ts";
import * as testing from "../testing.ts";
import { DAY_MS, HOUR_MS } from "../time.ts";

let env: Env;

beforeAll(async () => {
  env = await testing.createTestEnv();
});

let ids = 0;

// Each test reads its own day, far from the others and from now, so counts don't mix.
function day(offset: number) {
  const since = new Date(Date.UTC(2031, 0, 1 + offset * 3, 5));
  return { since, until: new Date(since.getTime() + DAY_MS) };
}

async function workspaceOn(name: string, at: Date) {
  ids += 1;
  const { cookie, user } = await testing.signIn(env);
  const { workspace } = await testing.createWorkspace(env, cookie, name, `digest-${ids}`);
  await env.DB.batch([
    env.DB.prepare("update user set created_at = ? where id = ?").bind(at.getTime(), user.id),
    env.DB.prepare("update workspace set created_at = ? where id = ?").bind(
      at.getTime(),
      workspace.id,
    ),
  ]);
  return { workspace, user };
}

async function decision(workspaceId: string, step: string | null, createdAt: Date) {
  ids += 1;
  await createDb(env.DB)
    .insert(schema.routeDecision)
    .values({
      workspaceId,
      repositoryId: 5_000 + ids,
      runId: ids,
      runAttempt: 1,
      step,
      runner: step && `rr-${ids}`,
      skipped: [],
      notInOrder: [],
      machine: [],
      github: [],
      createdAt,
    });
}

async function machineJob(installationId: number, machineId: string, completedAt: Date) {
  ids += 1;
  const minutes = 10;
  await createDb(env.DB)
    .insert(schema.jobTiming)
    .values({
      id: 70_000_000 + ids,
      installationId,
      repositoryId: 5_000,
      repositoryFullName: "example/app",
      runId: ids,
      runAttempt: 1,
      name: "test",
      labels: [`rr-${ids}`],
      conclusion: "success",
      runnerName: "runner",
      machineId,
      queuedAt: new Date(completedAt.getTime() - minutes * 60_000 - 1_000),
      startedAt: new Date(completedAt.getTime() - minutes * 60_000),
      completedAt,
    });
}

const empty: DigestCounts = {
  signups: 0,
  installs: [],
  firstMachines: [],
  firstMachineRuns: [],
  macAppUsers: 0,
  activeWorkspaces: 0,
  routed: [],
  unroutable: 0,
  machines: 0,
  machineJobs: 0,
  machineMinutes: 0,
  busiest: [],
};

describe("digest periods", () => {
  test("a weekday digest covers yesterday in US Eastern", () => {
    // Wednesday 13:00 UTC is 8 AM Eastern in winter.
    const { day, week } = digestPeriods(new Date("2026-11-25T13:00:00Z"));
    expect(day.since.toISOString()).toBe("2026-11-24T05:00:00.000Z");
    expect(day.until.toISOString()).toBe("2026-11-25T05:00:00.000Z");
    expect(week).toBeNull();
  });

  test("Monday adds last week, Monday to Sunday", () => {
    const { day, week } = digestPeriods(new Date("2026-11-30T13:00:00Z"));
    expect(day.since.toISOString()).toBe("2026-11-29T05:00:00.000Z");
    expect(week!.since.toISOString()).toBe("2026-11-23T05:00:00.000Z");
    expect(week!.until.toISOString()).toBe("2026-11-30T05:00:00.000Z");
  });

  test("days across a daylight saving change start at midnight", () => {
    // Clocks go back on Sunday, November 1 2026.
    expect(new Date(zoneMidnight(Date.parse("2026-11-02T13:00:00Z"), -1)).toISOString()).toBe(
      "2026-11-01T04:00:00.000Z",
    );
    const week = {
      since: new Date("2026-11-02T05:00:00Z"),
      until: new Date("2026-11-09T05:00:00Z"),
    };
    expect(previousPeriod(week).since.toISOString()).toBe("2026-10-26T04:00:00.000Z");
  });
});

describe("collectDigest", () => {
  test("counts arrivals and routed jobs, leaving our own workspaces out", async () => {
    const period = day(1);
    const at = new Date(period.since.getTime() + HOUR_MS);
    const { workspace } = await workspaceOn("Example Org", at);
    const { workspace: other } = await workspaceOn("Other Org", at);
    const ours = await testing.signInOperator(env);
    const { workspace: internal } = await testing.createWorkspace(
      env,
      ours.cookie,
      "Ours",
      "digest-ours",
    );

    await decision(workspace.id, "machine", at);
    await decision(workspace.id, "machine", at);
    await decision(workspace.id, "github", at);
    await decision(other.id, "github", at);
    await decision(other.id, null, at);
    await decision(internal.id, "machine", at);
    await recordEvent(createDb(env.DB), {
      workspaceId: workspace.id,
      type: "machine.connected",
      data: { machineName: "studio", runnerVersion: null },
      occurredAt: at,
    });
    await createDb(env.DB)
      .insert(schema.machine)
      .values({ id: "digest-machine", workspaceId: workspace.id, name: "studio" });
    await machineJob(workspace.installationId, "digest-machine", at);
    await machineJob(workspace.installationId, "digest-machine", at);

    const counts = await collectDigest(
      createDb(env.DB),
      period,
      await digestContext(createDb(env.DB)),
    );
    expect(counts).toMatchObject({
      signups: 2,
      installs: [workspace.slug, other.slug],
      firstMachines: ["Example Org"],
      firstMachineRuns: ["Example Org"],
      activeWorkspaces: 2,
      routed: [
        { step: "github", jobs: 2 },
        { step: "machine", jobs: 2 },
      ],
      unroutable: 1,
      machines: 1,
      machineJobs: 2,
      machineMinutes: 20,
      busiest: [
        { name: "Example Org", jobs: 3 },
        { name: "Other Org", jobs: 1 },
      ],
    });

    // The next day, a second run on a machine is no longer a first.
    const next = day(2);
    await decision(workspace.id, "machine", new Date(next.since.getTime() + 1_000));
    const later = await collectDigest(
      createDb(env.DB),
      next,
      await digestContext(createDb(env.DB)),
    );
    expect(later.firstMachineRuns).toEqual([]);
    expect(later.activeWorkspaces).toBe(1);
  });

  test("test accounts are left out", async () => {
    const period = day(3);
    const at = new Date(period.since.getTime() + 1_000);
    ids += 1;
    const { cookie, user, githubId } = await testing.signIn(env);
    await testing.createWorkspace(env, cookie, "Test Account", `digest-${ids}`);
    await env.DB.prepare("update user set created_at = ? where id = ?")
      .bind(at.getTime(), user.id)
      .run();
    await env.DB.prepare("update workspace set created_at = ? where slug = ?")
      .bind(at.getTime(), `digest-${ids}`)
      .run();
    const counts = await collectDigest(
      createDb(env.DB),
      period,
      await digestContext(createDb(env.DB), [githubId]),
    );
    expect(counts.signups).toBe(0);
    expect(counts.installs).toEqual([]);
  });
});

describe("formatDigest", () => {
  const period = {
    since: new Date("2026-11-24T05:00:00Z"),
    until: new Date("2026-11-25T05:00:00Z"),
  };

  test("lists what's new and the routing, against the day before", () => {
    const text = formatDigest(
      "daily",
      period,
      {
        ...empty,
        signups: 3,
        installs: ["example-org", "someone"],
        firstMachineRuns: ["Example Org"],
        macAppUsers: 1,
        activeWorkspaces: 9,
        routed: [
          { step: "machine", jobs: 1_200 },
          { step: "github", jobs: 800 },
        ],
        unroutable: 4,
        machines: 11,
        machineJobs: 1_150,
        machineMinutes: 6_240,
        busiest: [
          { name: "Example Org", jobs: 1_400 },
          { name: "Other Org", jobs: 600 },
        ],
      },
      {
        ...empty,
        signups: 1,
        installs: ["x"],
        activeWorkspaces: 7,
        routed: [{ step: "machine", jobs: 1_500 }],
        machineMinutes: 5_000,
      },
    );
    expect(text).toBe(
      [
        ":sunrise: *Daily digest* · Tue, Nov 24",
        "• 3 signups (was 1)",
        "• 2 installs (was 1): *example-org*, *someone*",
        "• First run on a machine: *Example Org*",
        "• 1 person started using the Mac app",
        "• 9 workspaces routed jobs (was 7)",
        "• 2K jobs routed (was 1.5K): 60% machines, 40% GitHub",
        "• 4 jobs couldn't be routed (was 0)",
        "• 11 machines ran 1.2K jobs, 6.2K CI minutes (was 5K)",
        "• Busiest: Example Org 1.4K · Other Org 600",
      ].join("\n"),
    );
  });

  test("a quiet week says so in one line", () => {
    const week = {
      since: new Date("2026-11-23T05:00:00Z"),
      until: new Date("2026-11-30T05:00:00Z"),
    };
    expect(formatDigest("weekly", week, empty, empty)).toBe(
      [
        ":calendar: *Weekly digest* · Mon, Nov 23 to Sun, Nov 29",
        "• No new signups or installs",
        "• 0 workspaces routed jobs",
      ].join("\n"),
    );
  });

  test("long name lists are cut short", async () => {
    const text = await buildDigest(
      createDb(env.DB),
      "daily",
      day(40),
      await digestContext(createDb(env.DB)),
    );
    expect(text).toContain("No new signups or installs");
    const many = formatDigest(
      "daily",
      period,
      { ...empty, firstMachines: ["a", "b", "c", "d", "e", "f", "g"] },
      empty,
    );
    expect(many).toContain("• First machine: *a*, *b*, *c*, *d*, *e* and 2 more");
  });
});

describe("sendOperatorDigests", () => {
  test("posts the daily digest, and the weekly one on Mondays", async () => {
    const fetcher = vi.fn(async () => new Response("ok"));
    const withSlack = { ...env, OPERATOR_SLACK_WEBHOOK_URL: "https://hooks.example.com/x" };
    expect(await sendOperatorDigests(withSlack, new Date("2026-11-25T13:00:00Z"), fetcher)).toBe(1);
    expect(await sendOperatorDigests(withSlack, new Date("2026-11-30T13:00:00Z"), fetcher)).toBe(2);
    const texts = fetcher.mock.calls.map(
      (call) => JSON.parse((call as unknown as [string, RequestInit])[1].body as string).text,
    );
    expect(texts.map((text: string) => text.split("\n")[0])).toEqual([
      ":sunrise: *Daily digest* · Tue, Nov 24",
      ":sunrise: *Daily digest* · Sun, Nov 29",
      ":calendar: *Weekly digest* · Mon, Nov 23 to Sun, Nov 29",
    ]);
  });

  test("does nothing without a webhook", async () => {
    expect(await sendOperatorDigests({ ...env, OPERATOR_SLACK_WEBHOOK_URL: undefined })).toBe(0);
  });
});
