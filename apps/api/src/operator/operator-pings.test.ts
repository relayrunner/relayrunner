import { recordEvent } from "../ingest/activity-log.ts";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { createDb, schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import {
  collectOperatorPings,
  parseGithubIds,
  PING_WINDOW_MS,
  pingUninstall,
  sendOperatorPings,
} from "./operator-pings.ts";
import { SETTLE_MS } from "../routing/stickiness.ts";
import * as testing from "../testing.ts";

let env: Env;

beforeAll(async () => {
  env = await testing.createTestEnv();
});

let ids = 0;

async function workspace(name: string) {
  ids += 1;
  const { cookie: signedIn, user, githubId } = await testing.signIn(env);
  const { workspace } = await testing.createWorkspace(env, signedIn, name, `pings-${ids}`);
  return { workspace, user, githubId };
}

async function machineArrives(
  workspaceId: string,
  type: "machine.enrolled" | "machine.connected",
  occurredAt: Date,
) {
  ids += 1;
  const machineId = `pings-machine-${ids}`;
  const db = createDb(env.DB);
  await db
    .insert(schema.machine)
    .values({ id: machineId, workspaceId, name: "studio", os: "macos", deviceModel: "Mac mini" });
  await recordEvent(
    db,
    type === "machine.enrolled"
      ? {
          workspaceId,
          machineId,
          type,
          data: { machineName: "studio", os: "macos", arch: "arm64" },
          occurredAt,
        }
      : {
          workspaceId,
          machineId,
          type,
          data: { machineName: "studio", runnerVersion: null },
          occurredAt,
        },
  );
}

/** `userId`'s first Mac app hello, from a machine taking jobs in `workspaceId`. */
async function macAppUse(userId: string, workspaceId: string, firstUsedAt: Date) {
  ids += 1;
  const machineId = `pings-mac-${ids}`;
  const db = createDb(env.DB);
  await db.insert(schema.machine).values({
    id: machineId,
    userId,
    name: "studio",
    os: "macos",
    deviceModel: "MacBook Pro",
    macAppVersion: "0.7.0",
  });
  await db.insert(schema.machineWorkspace).values({ machineId, workspaceId });
  await db
    .insert(schema.macAppFirstUse)
    .values({ userId, machineId, macAppVersion: "0.7.0", firstUsedAt });
}

async function machineRun(workspaceId: string, createdAt: Date) {
  ids += 1;
  await createDb(env.DB)
    .insert(schema.routeDecision)
    .values({
      workspaceId,
      repositoryId: 7_000 + ids,
      runId: ids,
      runAttempt: 1,
      step: "machine",
      runner: `rr-${ids}`,
      skipped: [],
      notInOrder: [],
      machine: [],
      github: [],
      startedByLogin: "dana",
      createdAt,
    });
}

async function unroutable(workspaceId: string, occurredAt: Date, reason: string) {
  ids += 1;
  await recordEvent(createDb(env.DB), {
    workspaceId,
    type: "job.unroutable",
    data: {
      repository: "acme/app",
      runId: ids,
      runAttempt: 1,
      workflow: "CI",
      job: "relay",
      reason,
      walk: null,
    },
    occurredAt,
  });
}

/** A first-attempt CI run on main, first seen at `seenAt`, with a pick when relayed. */
async function ciRun(installationId: number, seenAt: Date, relayed: boolean, branch = "main") {
  ids += 1;
  const runId = 90_000 + ids;
  const db = createDb(env.DB);
  await db.insert(schema.workflowRun).values({
    id: runId,
    runAttempt: 1,
    installationId,
    repositoryId: 8_000,
    repositoryFullName: "acme/dropped",
    workflowName: "CI",
    workflowPath: ".github/workflows/ci.yml",
    defaultBranch: "main",
    event: "push",
    headBranch: branch,
    headSha: "abc",
    status: "completed",
    conclusion: "success",
    runStartedAt: seenAt,
    githubUpdatedAt: seenAt,
    createdAt: seenAt,
  });
  if (!relayed) return;
  await db.insert(schema.workflowJob).values({
    id: runId * 10,
    installationId,
    repositoryId: 8_000,
    repositoryFullName: "acme/dropped",
    runId,
    runAttempt: 1,
    kind: "pick",
    name: "relay",
    labels: ["relayrunner"],
    headSha: "abc",
    status: "completed",
    githubCreatedAt: seenAt,
  });
}

function window() {
  const until = new Date(Date.now() + 1_000);
  return { since: new Date(until.getTime() - PING_WINDOW_MS), until };
}

function about(pings: string[], name: string) {
  return pings.filter((ping) => ping.includes(name));
}

describe("operator pings", () => {
  test("pings a signup and an App install", async () => {
    const { workspace: ws, user } = await workspace("Kiln Dev");
    const { since, until } = window();
    const pings = await collectOperatorPings(createDb(env.DB), since, until);
    expect(about(pings, user.email)).toEqual([`:wave: New signup: *${user.name}* (${user.email})`]);
    expect(about(pings, ws.slug)).toEqual([
      `:electric_plug: App installed on the org *<https://github.com/${ws.slug}|${ws.slug}>* (all repos)`,
    ]);
  });

  test("pings a workspace's first machine once, not later arrivals", async () => {
    const { workspace: ws } = await workspace("First Machine");
    const now = Date.now();
    await machineArrives(ws.id, "machine.enrolled", new Date(now - 1_000));
    await machineArrives(ws.id, "machine.connected", new Date(now - 500));
    const db = createDb(env.DB);
    const { since, until } = window();
    expect(about(await collectOperatorPings(db, since, until), "First Machine")).toEqual([
      ":computer: *First Machine*: first machine connected, studio (Mac mini, macos)",
    ]);

    // The next window: another connect isn't a first.
    await machineArrives(ws.id, "machine.connected", new Date(until.getTime() + 1_000));
    const later = await collectOperatorPings(db, until, new Date(until.getTime() + PING_WINDOW_MS));
    expect(about(later, "First Machine")).toEqual([]);
  });

  test("pings someone's first use of the Mac app once", async () => {
    const { workspace: ws, user } = await workspace("Mac Co");
    await macAppUse(user.id, ws.id, new Date(Date.now() - 500));
    const db = createDb(env.DB);
    const { since, until } = window();
    expect(about(await collectOperatorPings(db, since, until), "Mac Co")).toEqual([
      `:apple: *${user.name}* started using the Mac app 0.7.0 on studio (MacBook Pro) for *Mac Co*`,
    ]);
    const later = await collectOperatorPings(db, until, new Date(until.getTime() + PING_WINDOW_MS));
    expect(about(later, "Mac Co")).toEqual([]);
  });

  test("pings a workspace's first run on a machine once", async () => {
    const { workspace: ws } = await workspace("First Run");
    const now = Date.now();
    await machineRun(ws.id, new Date(now - 2_000));
    await machineRun(ws.id, new Date(now - 1_000));
    const db = createDb(env.DB);
    const { since, until } = window();
    expect(about(await collectOperatorPings(db, since, until), "First Run")).toEqual([
      ":tada: *First Run*: first run routed to a machine, started by dana",
    ]);
    await machineRun(ws.id, new Date(until.getTime() + 1_000));
    const later = await collectOperatorPings(db, until, new Date(until.getTime() + PING_WINDOW_MS));
    expect(about(later, "First Run")).toEqual([]);
  });

  test("batches unroutable runs into one ping per workspace, naming the latest", async () => {
    const { workspace: ws } = await workspace("Stuck Co");
    const now = Date.now();
    await unroutable(ws.id, new Date(now - 2_000), "nothing fits: machine offline");
    await unroutable(ws.id, new Date(now - 1_000), "nothing fits: github not set");
    const { since, until } = window();
    const pings = about(await collectOperatorPings(createDb(env.DB), since, until), "Stuck Co");
    expect(pings).toHaveLength(1);
    expect(pings[0]).toMatch(
      /^:warning: \*Stuck Co\*: 2 runs couldn't be routed in the last 15 minutes\. Latest in <https:\/\/github\.com\/acme\/app\/actions\/runs\/\d+\|acme\/app>: "nothing fits: github not set"$/,
    );
  });

  test("pings once when a workspace that adopted the relay takes it out", async () => {
    const { workspace: ws } = await workspace("Dropped Co");
    const db = createDb(env.DB);
    const [row] = await db
      .select({ installationId: schema.workspace.installationId })
      .from(schema.workspace)
      .where(eq(schema.workspace.id, ws.id));
    const installationId = row!.installationId;
    const now = Date.now();
    const hoursAgo = (hours: number) => new Date(now - hours * 3_600_000);
    await ciRun(installationId, hoursAgo(5), true);
    await ciRun(installationId, hoursAgo(4), false);
    await ciRun(installationId, hoursAgo(3), false);
    // The third run without the relay settles in this window.
    await ciRun(installationId, new Date(now - SETTLE_MS - 1_000), false);
    const { since, until } = window();
    const pings = about(await collectOperatorPings(db, since, until), "Dropped Co");
    expect(pings).toHaveLength(1);
    expect(pings[0]).toMatch(
      /^:leftwards_arrow_with_hook: \*Dropped Co\* took the relay out: 3 runs without it in <https:\/\/github\.com\/acme\/dropped\|acme\/dropped> since its last relay \(<https:\/\/github\.com\/acme\/dropped\/blob\/HEAD\/\.github\/workflows\/ci\.yml\|CI>, /,
    );
    const later = await collectOperatorPings(db, until, new Date(until.getTime() + PING_WINDOW_MS));
    expect(about(later, "Dropped Co")).toEqual([]);
  });

  test("runs off the default branch without the relay don't say it was taken out", async () => {
    // A gated relay skipped on a PR branch, or a branch that never had it: only main counts.
    const { workspace: ws } = await workspace("Branch Co");
    const db = createDb(env.DB);
    const [row] = await db
      .select({ installationId: schema.workspace.installationId })
      .from(schema.workspace)
      .where(eq(schema.workspace.id, ws.id));
    const installationId = row!.installationId;
    const now = Date.now();
    await ciRun(installationId, new Date(now - 5 * 3_600_000), true);
    await ciRun(installationId, new Date(now - 4 * 3_600_000), false, "docs-only");
    await ciRun(installationId, new Date(now - 3 * 3_600_000), false, "docs-only");
    await ciRun(installationId, new Date(now - SETTLE_MS - 1_000), false, "docs-only");
    const { since, until } = window();
    expect(about(await collectOperatorPings(db, since, until), "Branch Co")).toEqual([]);
  });

  test("pings an uninstall before the workspace is forgotten", async () => {
    const { workspace: ws } = await workspace("Gone Co");
    const db = createDb(env.DB);
    const [row] = await db
      .select({ installationId: schema.workspace.installationId })
      .from(schema.workspace)
      .where(eq(schema.workspace.id, ws.id));
    const fetcher = vi.fn().mockResolvedValue(new Response("ok"));
    const env2 = { ...env, OPERATOR_SLACK_WEBHOOK_URL: "https://hooks.slack.com/x" };
    const at = Date.now() + 3 * 24 * 3_600_000;
    const sent = await pingUninstall(env2, db, row!.installationId, at, fetcher as never);
    expect(sent).toBe(true);
    const body = JSON.parse(fetcher.mock.calls[0]![1].body as string) as { text: string };
    expect(body.text).toMatch(/^:wastebasket: App uninstalled from the .+ after 3 days$/);
    // Already gone (an operator delete): nothing to say.
    expect(await pingUninstall(env2, db, 987_654_321, at, fetcher as never)).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("leaves out operators' signups and our own workspaces, but not a user's org with an operator in it", async () => {
    const db = createDb(env.DB);
    const member = await workspace("Ours Member");
    await db
      .update(schema.user)
      .set({ role: "operator" })
      .where(eq(schema.user.id, member.user.id));
    await machineArrives(member.workspace.id, "machine.connected", new Date());
    await unroutable(member.workspace.id, new Date(), "nothing fits");
    await macAppUse(member.user.id, member.workspace.id, new Date());

    // Installed by an operator who isn't a member (yet).
    const installed = await workspace("Ours Installed");
    await db
      .delete(schema.workspaceMember)
      .where(eq(schema.workspaceMember.workspaceId, installed.workspace.id));
    await db
      .update(schema.githubInstallation)
      .set({ installerGithubId: member.githubId })
      .where(eq(schema.githubInstallation.id, installed.workspace.installationId));
    await machineRun(installed.workspace.id, new Date());

    // A real user's org that invited an operator in still pings.
    const theirs = await workspace("Theirs With Us");
    await db.insert(schema.workspaceMember).values({
      id: crypto.randomUUID(),
      workspaceId: theirs.workspace.id,
      userId: member.user.id,
      role: "member",
    });
    await unroutable(theirs.workspace.id, new Date(), "nothing fits");

    const { since, until } = window();
    const pings = await collectOperatorPings(db, since, until);
    expect(about(pings, "Theirs With Us")).toHaveLength(1);
    expect(about(pings, "Ours")).toEqual([]);
    expect(about(pings, member.user.email)).toEqual([]);
    expect(about(pings, `*${member.user.name}* started using the Mac app`)).toEqual([]);
    expect(about(pings, member.workspace.slug)).toEqual([]);
    expect(about(pings, installed.workspace.slug)).toEqual([]);
  });

  test("leaves out test accounts by GitHub id, but not workspaces real users are in", async () => {
    const db = createDb(env.DB);
    const tester = await workspace("Tester Only");
    await unroutable(tester.workspace.id, new Date(), "nothing fits");

    // A real user's workspace the test account joined still pings.
    const shared = await workspace("Shared With Tester");
    await db.insert(schema.workspaceMember).values({
      id: crypto.randomUUID(),
      workspaceId: shared.workspace.id,
      userId: tester.user.id,
      role: "member",
    });
    await unroutable(shared.workspace.id, new Date(), "nothing fits");

    // The test account's personal install, before anyone synced into it.
    const personal = await workspace("Tester Personal");
    await db
      .delete(schema.workspaceMember)
      .where(eq(schema.workspaceMember.workspaceId, personal.workspace.id));
    await db
      .update(schema.githubInstallation)
      .set({ accountId: tester.githubId, accountType: "User" })
      .where(eq(schema.githubInstallation.id, personal.workspace.installationId));
    await machineRun(personal.workspace.id, new Date());

    const { since, until } = window();
    const pings = await collectOperatorPings(db, since, until, [tester.githubId]);
    expect(about(pings, tester.user.email)).toEqual([]);
    expect(about(pings, "Tester Only")).toEqual([]);
    expect(about(pings, tester.workspace.slug)).toEqual([]);
    expect(about(pings, "Tester Personal")).toEqual([]);
    expect(about(pings, personal.workspace.slug)).toEqual([]);
    expect(about(pings, "Shared With Tester")).toHaveLength(1);

    // Without the list, the test account pings like anyone.
    const unfiltered = await collectOperatorPings(db, since, until);
    expect(about(unfiltered, tester.user.email)).toHaveLength(1);
    expect(about(unfiltered, "Tester Only")).toHaveLength(1);
  });

  test("reads the ignore list from a comma-separated var", () => {
    expect(parseGithubIds(" 8841125, 42 ,,nope,-1")).toEqual([8841125, 42]);
    expect(parseGithubIds(undefined)).toEqual([]);
  });

  test("escapes names for Slack", async () => {
    const { workspace: ws } = await workspace("<!channel> & co");
    await unroutable(ws.id, new Date(), "nope");
    const { since, until } = window();
    const pings = await collectOperatorPings(createDb(env.DB), since, until);
    expect(about(pings, "&lt;!channel&gt; &amp; co")).toHaveLength(1);
    expect(pings.some((ping) => ping.includes("<!channel>"))).toBe(false);
  });

  test("posts each ping to the Slack webhook, and does nothing without one", async () => {
    const fetcher = vi.fn(async () => new Response("ok"));
    const { workspace: ws } = await workspace("Posted");
    await unroutable(ws.id, new Date(), "nope");
    const at = new Date(Date.now() + 1_000);

    expect(await sendOperatorPings(env, at, fetcher)).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();

    const url = "https://hooks.slack.com/services/T/B/x";
    const sent = await sendOperatorPings({ ...env, OPERATOR_SLACK_WEBHOOK_URL: url }, at, fetcher);
    expect(sent).toBeGreaterThan(0);
    expect(fetcher).toHaveBeenCalledTimes(sent);
    const bodies = fetcher.mock.calls.map(
      (call) => JSON.parse((call as unknown as [string, RequestInit])[1].body as string).text,
    );
    expect(bodies.some((text: string) => text.includes("*Posted*"))).toBe(true);
    expect((fetcher.mock.calls[0] as unknown as [string])[0]).toBe(url);
  });

  test("a failed post is logged and the rest still go out", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("no", { status: 500 }))
      .mockResolvedValue(new Response("ok"));
    const { workspace: a } = await workspace("Fail A");
    const { workspace: b } = await workspace("Fail B");
    await unroutable(a.id, new Date(), "x");
    await unroutable(b.id, new Date(), "y");
    const at = new Date(Date.now() + 1_000);
    const env2 = { ...env, OPERATOR_SLACK_WEBHOOK_URL: "https://hooks.slack.com/x" };
    const total = (
      await collectOperatorPings(createDb(env.DB), new Date(at.getTime() - PING_WINDOW_MS), at)
    ).length;
    const sent = await sendOperatorPings(env2, at, fetcher as unknown as typeof fetch);
    expect(sent).toBe(total - 1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("operator ping not sent"));
    error.mockRestore();
  });
});
