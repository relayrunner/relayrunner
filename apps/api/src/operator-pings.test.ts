import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { recordEvent } from "./activity.ts";
import { createDb, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import { collectOperatorPings, PING_WINDOW_MS, sendOperatorPings } from "./operator-pings.ts";
import * as testing from "./testing.ts";

let proxy: Awaited<ReturnType<typeof testing.startD1>>["proxy"];
let env: Env;

beforeAll(async () => {
  ({ proxy, env } = await testing.startD1());
}, 60_000);

afterAll(async () => {
  await proxy?.dispose();
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
      `:electric_plug: App installed on the org *${ws.slug}* (all repos)`,
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
    expect(about(await collectOperatorPings(createDb(env.DB), since, until), "Stuck Co")).toEqual([
      ':warning: *Stuck Co*: 2 runs couldn\'t be routed in the last 15 minutes. Latest in acme/app: "nothing fits: github not set"',
    ]);
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
    expect(about(pings, member.workspace.slug)).toEqual([]);
    expect(about(pings, installed.workspace.slug)).toEqual([]);
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
