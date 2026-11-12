/**
 * Tells operators about early-access milestones in Slack: a new signup, an App install, a
 * workspace's first machine, its first job on a machine, and runs that couldn't be routed. The
 * 15-minute cron (wrangler.jsonc `triggers`) reads what happened in the window that just ended from
 * D1 and posts one message per ping to OPERATOR_SLACK_WEBHOOK_URL. Nothing is stored: each window
 * is read once, so a skipped cron run skips its pings.
 *
 * Our own workspaces (internalWorkspaceIds) and operators' own signups are left out, so our own
 * testing stays quiet. So are test accounts that aren't operators, by GitHub user id
 * (OPERATOR_PINGS_IGNORE_GITHUB_IDS): their signups, their personal account's install, and
 * workspaces where everyone is a test account or an operator.
 */
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { type Db, createDb, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import { internalWorkspaceIds } from "./internal-workspaces.ts";

export const PING_WINDOW_MS = 15 * 60 * 1000;
const MACHINE_ARRIVALS = ["machine.enrolled", "machine.connected"];

/** Escapes text for Slack's mrkdwn, so a name can't add formatting or links. */
function esc(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Posts `text` to a Slack (`text`) or Discord (`content`) incoming webhook. Throws on a non-2xx. */
export async function postToWebhook(url: string, text: string, fetcher: typeof fetch = fetch) {
  const response = await fetcher(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, content: text }),
  });
  if (!response.ok) throw new Error(`webhook answered ${response.status}`);
}

/** GitHub user ids from a comma-separated list, ignoring anything that isn't one. */
export function parseGithubIds(value: string | undefined): number[] {
  return (value ?? "")
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((id) => Number.isInteger(id) && id > 0);
}

/**
 * The test accounts' users, and the workspaces that are only theirs: everyone in it is a test
 * account or an operator, it's a test account's personal install, or, before members sync, a test
 * account installed it.
 */
async function testAccounts(db: Db, githubIds: number[]) {
  if (githubIds.length === 0) return { users: new Set<string>(), workspaces: new Set<string>() };
  const ids = githubIds.map(String);
  const accounts = await db
    .select({ userId: schema.account.userId })
    .from(schema.account)
    .where(and(eq(schema.account.providerId, "github"), inArray(schema.account.accountId, ids)));
  const users = new Set(accounts.map((row) => row.userId));
  const [members, installs] = await Promise.all([
    db
      .select({
        workspaceId: schema.workspaceMember.workspaceId,
        userId: schema.workspaceMember.userId,
        role: schema.user.role,
      })
      .from(schema.workspaceMember)
      .innerJoin(schema.user, eq(schema.user.id, schema.workspaceMember.userId)),
    db
      .select({
        id: schema.workspace.id,
        accountId: schema.githubInstallation.accountId,
        installerGithubId: schema.githubInstallation.installerGithubId,
        members: sql<number>`(select count(*) from ${schema.workspaceMember} where ${schema.workspaceMember.workspaceId} = ${schema.workspace.id})`,
      })
      .from(schema.workspace)
      .innerJoin(
        schema.githubInstallation,
        eq(schema.githubInstallation.id, schema.workspace.installationId),
      ),
  ]);
  const workspaces = new Set<string>();
  for (const [workspaceId, rows] of Map.groupBy(members, (row) => row.workspaceId)) {
    if (
      rows.some((row) => users.has(row.userId)) &&
      rows.every((row) => users.has(row.userId) || row.role === "operator")
    )
      workspaces.add(workspaceId);
  }
  for (const install of installs) {
    if (
      githubIds.includes(install.accountId) ||
      (Number(install.members) === 0 &&
        install.installerGithubId !== null &&
        githubIds.includes(install.installerGithubId))
    )
      workspaces.add(install.id);
  }
  return { users, workspaces };
}

/**
 * The pings for what happened in [since, until), oldest first. `ignoredGithubIds` are test
 * accounts to leave out, like our own.
 */
export async function collectOperatorPings(
  db: Db,
  since: Date,
  until: Date,
  ignoredGithubIds: number[] = [],
): Promise<string[]> {
  const tests = await testAccounts(db, ignoredGithubIds);
  const ours = new Set([...(await internalWorkspaceIds(db)), ...tests.workspaces]);
  const pings: { at: number; text: string }[] = [];

  const signups = await db
    .select({
      id: schema.user.id,
      name: schema.user.name,
      email: schema.user.email,
      createdAt: schema.user.createdAt,
      role: schema.user.role,
    })
    .from(schema.user)
    .where(and(gte(schema.user.createdAt, since), lt(schema.user.createdAt, until)));
  for (const user of signups) {
    if (user.role === "operator" || tests.users.has(user.id)) continue;
    pings.push({
      at: user.createdAt.getTime(),
      text: `:wave: New signup: *${esc(user.name)}* (${esc(user.email)})`,
    });
  }

  const installs = await db
    .select({
      id: schema.workspace.id,
      name: schema.workspace.name,
      createdAt: schema.workspace.createdAt,
      login: schema.githubInstallation.accountLogin,
      type: schema.githubInstallation.accountType,
      selection: schema.githubInstallation.repositorySelection,
    })
    .from(schema.workspace)
    .innerJoin(
      schema.githubInstallation,
      eq(schema.githubInstallation.id, schema.workspace.installationId),
    )
    .where(and(gte(schema.workspace.createdAt, since), lt(schema.workspace.createdAt, until)));
  for (const install of installs) {
    if (ours.has(install.id)) continue;
    const kind = install.type === "Organization" ? "org" : "personal account";
    const repos = install.selection === "all" ? "all repos" : "selected repos";
    pings.push({
      at: install.createdAt.getTime(),
      text: `:electric_plug: App installed on the ${kind} *${esc(install.login)}* (${repos})`,
    });
  }

  const events = schema.activityEvent;
  const inWindow = and(gte(events.occurredAt, since), lt(events.occurredAt, until));

  // A workspace's first machine: an arrival in the window with none before it in that workspace.
  const arrivals = await db
    .select({
      id: events.id,
      workspaceId: events.workspaceId,
      workspace: schema.workspace.name,
      data: events.data,
      occurredAt: events.occurredAt,
      deviceModel: schema.machine.deviceModel,
      os: schema.machine.os,
      source: schema.machine.source,
    })
    .from(events)
    .innerJoin(schema.workspace, eq(schema.workspace.id, events.workspaceId))
    .leftJoin(schema.machine, eq(schema.machine.id, events.machineId))
    .where(and(inArray(events.type, MACHINE_ARRIVALS), inWindow))
    .orderBy(events.id);
  const firstMachineSeen = new Set<string>();
  for (const arrival of arrivals) {
    if (ours.has(arrival.workspaceId) || firstMachineSeen.has(arrival.workspaceId)) continue;
    firstMachineSeen.add(arrival.workspaceId);
    const [before] = await db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.workspaceId, arrival.workspaceId),
          inArray(events.type, MACHINE_ARRIVALS),
          lt(events.id, arrival.id),
        ),
      )
      .limit(1);
    if (before) continue;
    const name =
      typeof arrival.data.machineName === "string" ? arrival.data.machineName : "a machine";
    const about = [arrival.deviceModel, arrival.os].filter(Boolean).join(", ");
    const what =
      arrival.source === "github" ? "first self-hosted runner added" : "first machine connected";
    pings.push({
      at: arrival.occurredAt.getTime(),
      text: `:computer: *${esc(arrival.workspace)}*: ${what}, ${esc(name)}${about ? ` (${esc(about)})` : ""}`,
    });
  }

  // A workspace's first run routed to a machine.
  const decisions = schema.routeDecision;
  const machineRuns = await db
    .select({
      id: decisions.id,
      workspaceId: decisions.workspaceId,
      workspace: schema.workspace.name,
      repository: schema.githubRepository.fullName,
      startedBy: decisions.startedByLogin,
      createdAt: decisions.createdAt,
    })
    .from(decisions)
    .innerJoin(schema.workspace, eq(schema.workspace.id, decisions.workspaceId))
    .leftJoin(schema.githubRepository, eq(schema.githubRepository.id, decisions.repositoryId))
    .where(
      and(
        eq(decisions.step, "machine"),
        gte(decisions.createdAt, since),
        lt(decisions.createdAt, until),
      ),
    )
    .orderBy(decisions.id);
  const firstJobSeen = new Set<string>();
  for (const run of machineRuns) {
    if (ours.has(run.workspaceId) || firstJobSeen.has(run.workspaceId)) continue;
    firstJobSeen.add(run.workspaceId);
    const [before] = await db
      .select({ id: decisions.id })
      .from(decisions)
      .where(
        and(
          eq(decisions.workspaceId, run.workspaceId),
          eq(decisions.step, "machine"),
          lt(decisions.id, run.id),
        ),
      )
      .limit(1);
    if (before) continue;
    const where = run.repository ? ` in ${esc(run.repository)}` : "";
    const who = run.startedBy ? `, started by ${esc(run.startedBy)}` : "";
    pings.push({
      at: run.createdAt.getTime(),
      text: `:tada: *${esc(run.workspace)}*: first run routed to a machine${where}${who}`,
    });
  }

  // Runs that couldn't be routed, one ping per workspace for the window.
  const unroutable = await db
    .select({
      workspaceId: events.workspaceId,
      workspace: schema.workspace.name,
      data: events.data,
      occurredAt: events.occurredAt,
    })
    .from(events)
    .innerJoin(schema.workspace, eq(schema.workspace.id, events.workspaceId))
    .where(and(eq(events.type, "job.unroutable"), inWindow))
    .orderBy(desc(events.id));
  const byWorkspace = Map.groupBy(
    unroutable.filter((row) => !ours.has(row.workspaceId)),
    (row) => row.workspaceId,
  );
  for (const rows of byWorkspace.values()) {
    const latest = rows[0]!;
    const repository = typeof latest.data.repository === "string" ? latest.data.repository : null;
    const reason = typeof latest.data.reason === "string" ? latest.data.reason : null;
    const runs = rows.length === 1 ? "1 run" : `${rows.length} runs`;
    const detail = [repository && `in ${esc(repository)}`, reason && `"${esc(reason)}"`]
      .filter(Boolean)
      .join(": ");
    pings.push({
      at: latest.occurredAt.getTime(),
      text: `:warning: *${esc(latest.workspace)}*: ${runs} couldn't be routed in the last 15 minutes${detail ? `. Latest ${detail}` : ""}`,
    });
  }

  return pings.sort((a, b) => a.at - b.at).map((ping) => ping.text);
}

/**
 * The cron's entry: posts the pings for the 15 minutes before `at`. Does nothing without
 * OPERATOR_SLACK_WEBHOOK_URL. A failed post is logged and the rest still go out.
 */
export async function sendOperatorPings(
  env: Env,
  at = new Date(),
  fetcher: typeof fetch = fetch,
): Promise<number> {
  const url = env.OPERATOR_SLACK_WEBHOOK_URL;
  if (!url) return 0;
  const until = new Date(at.getTime());
  const since = new Date(until.getTime() - PING_WINDOW_MS);
  const pings = await collectOperatorPings(
    createDb(env.DB),
    since,
    until,
    parseGithubIds(env.OPERATOR_PINGS_IGNORE_GITHUB_IDS),
  );
  let sent = 0;
  for (const text of pings) {
    try {
      await postToWebhook(url, text, fetcher);
      sent += 1;
    } catch (error) {
      console.error(
        JSON.stringify({
          msg: "operator ping not sent",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
  return sent;
}
