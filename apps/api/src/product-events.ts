/**
 * Sends the product funnel to PostHog from the server: signups, App installs, machines connected
 * and jobs routed. The browser can miss these (a tab closed mid-install, a machine connected from
 * the CLI, a job routed while nobody was looking), so they come from D1 instead. The dashboard
 * (apps/web/src/lib/analytics.ts) identifies people by the same user id, so these join the
 * site and dashboard events in one funnel.
 *
 * Like the operator pings (src/operator-pings.ts), the 15-minute cron reads what happened in the
 * window that just ended and sends it in one batch, each event at the time it happened. Nothing is
 * stored, so a skipped cron run skips its window. Our own workspaces and operators, and the test
 * accounts in OPERATOR_PINGS_IGNORE_GITHUB_IDS, are left out the same way. Does nothing without
 * POSTHOG_TOKEN.
 */
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { type Db, createDb, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import { internalWorkspaceIds } from "./internal-workspaces.ts";
import { PING_WINDOW_MS, parseGithubIds, testAccounts } from "./operator-pings.ts";

const POSTHOG_BATCH_URL = "https://us.i.posthog.com/batch/";
const MACHINE_ARRIVALS = ["machine.enrolled", "machine.connected"];

export type ProductEvent = {
  event: string;
  distinct_id: string;
  timestamp: string;
  properties: Record<string, unknown>;
};

/** The id for events about a workspace rather than a person: they make no person profile. */
const workspaceActor = (workspaceId: string) => `workspace:${workspaceId}`;

/** The properties every server event carries, putting it in its workspace's group. */
function base(workspaceId: string | null, personless = false) {
  return {
    app: "api",
    ...(workspaceId ? { $groups: { workspace: workspaceId } } : {}),
    ...(personless ? { $process_person_profile: false } : {}),
  };
}

/** The product events for what happened in [since, until), oldest first. */
export async function collectProductEvents(
  db: Db,
  since: Date,
  until: Date,
  ignoredGithubIds: number[] = [],
): Promise<ProductEvent[]> {
  const tests = await testAccounts(db, ignoredGithubIds);
  const ours = new Set([...(await internalWorkspaceIds(db)), ...tests.workspaces]);
  const events: ProductEvent[] = [];

  const signups = await db
    .select({
      id: schema.user.id,
      name: schema.user.name,
      createdAt: schema.user.createdAt,
      role: schema.user.role,
    })
    .from(schema.user)
    .where(and(gte(schema.user.createdAt, since), lt(schema.user.createdAt, until)));
  for (const user of signups) {
    if (user.role === "operator" || tests.users.has(user.id)) continue;
    events.push({
      event: "signed_up",
      distinct_id: user.id,
      timestamp: user.createdAt.toISOString(),
      properties: { ...base(null), $set: { name: user.name } },
    });
  }

  // App installs, credited to whoever installed it when they've signed in to RelayRunner.
  const installer = sql<
    string | null
  >`(select ${schema.account.userId} from ${schema.account} where ${schema.account.providerId} = 'github' and ${schema.account.accountId} = cast(github_installation.installer_github_id as text) limit 1)`;
  const installs = await db
    .select({
      id: schema.workspace.id,
      name: schema.workspace.name,
      slug: schema.workspace.slug,
      createdAt: schema.workspace.createdAt,
      accountType: schema.githubInstallation.accountType,
      selection: schema.githubInstallation.repositorySelection,
      installer,
    })
    .from(schema.workspace)
    .innerJoin(
      schema.githubInstallation,
      eq(schema.githubInstallation.id, schema.workspace.installationId),
    )
    .where(and(gte(schema.workspace.createdAt, since), lt(schema.workspace.createdAt, until)));
  for (const install of installs) {
    if (ours.has(install.id)) continue;
    const timestamp = install.createdAt.toISOString();
    const accountType = install.accountType === "Organization" ? "organization" : "personal";
    events.push({
      event: "$groupidentify",
      distinct_id: workspaceActor(install.id),
      timestamp,
      properties: {
        ...base(null, true),
        $group_type: "workspace",
        $group_key: install.id,
        $group_set: { name: install.name, slug: install.slug, account_type: accountType },
      },
    });
    events.push({
      event: "github_app_installed",
      distinct_id: install.installer ?? workspaceActor(install.id),
      timestamp,
      properties: {
        ...base(install.id, !install.installer),
        account_type: accountType,
        repository_selection: install.selection,
      },
    });
  }

  // A machine's first arrival in a workspace: enrolled with `relayrunner connect`, or a GitHub
  // self-hosted runner seen for the first time. Reconnects aren't events.
  const activity = schema.activityEvent;
  const arrivals = await db
    .select({
      id: activity.id,
      workspaceId: activity.workspaceId,
      machineId: activity.machineId,
      occurredAt: activity.occurredAt,
      owner: schema.machine.userId,
      os: schema.machine.os,
      arch: schema.machine.arch,
      deviceModel: schema.machine.deviceModel,
      source: schema.machine.source,
    })
    .from(activity)
    .leftJoin(schema.machine, eq(schema.machine.id, activity.machineId))
    .where(
      and(
        inArray(activity.type, MACHINE_ARRIVALS),
        gte(activity.occurredAt, since),
        lt(activity.occurredAt, until),
      ),
    )
    .orderBy(activity.id);
  const seen = new Set<string>();
  for (const arrival of arrivals) {
    if (!arrival.machineId || ours.has(arrival.workspaceId)) continue;
    const key = `${arrival.workspaceId}/${arrival.machineId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const [before] = await db
      .select({ id: activity.id })
      .from(activity)
      .where(
        and(
          eq(activity.workspaceId, arrival.workspaceId),
          eq(activity.machineId, arrival.machineId),
          inArray(activity.type, MACHINE_ARRIVALS),
          lt(activity.id, arrival.id),
        ),
      )
      .limit(1);
    if (before) continue;
    events.push({
      event: "machine_connected",
      distinct_id: arrival.owner ?? workspaceActor(arrival.workspaceId),
      timestamp: arrival.occurredAt.toISOString(),
      properties: {
        ...base(arrival.workspaceId, !arrival.owner),
        machine_id: arrival.machineId,
        source: arrival.source,
        os: arrival.os,
        arch: arrival.arch,
        device_model: arrival.deviceModel,
      },
    });
  }

  // Every routing decision: which step of the runner order took the job.
  const decisions = schema.routeDecision;
  // A job on a machine is credited to the machine's owner, so the per-person funnel reaches its
  // last step without group analytics. The job may not have a machine yet at the window's edge;
  // then it's whoever started the run, when they've signed in. Other jobs belong to the workspace.
  const machineOwner = sql<
    string | null
  >`(select m.user_id from workflow_job j inner join machine m on m.id = j.machine_id where j.repository_id = route_decision.repository_id and j.run_id = route_decision.run_id limit 1)`;
  const starter = sql<
    string | null
  >`(select a.user_id from account a where a.provider_id = 'github' and a.account_id = cast(route_decision.started_by_id as text) limit 1)`;
  const routed = await db
    .select({
      workspaceId: decisions.workspaceId,
      step: decisions.step,
      createdAt: decisions.createdAt,
      machineOwner,
      starter,
    })
    .from(decisions)
    .where(and(gte(decisions.createdAt, since), lt(decisions.createdAt, until)))
    .orderBy(decisions.id);
  for (const decision of routed) {
    if (ours.has(decision.workspaceId)) continue;
    const person = decision.step === "machine" ? (decision.machineOwner ?? decision.starter) : null;
    events.push({
      event: "job_routed",
      distinct_id: person ?? workspaceActor(decision.workspaceId),
      timestamp: decision.createdAt.toISOString(),
      properties: { ...base(decision.workspaceId, !person), step: decision.step ?? "none" },
    });
  }

  return events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/**
 * The cron's entry: sends the events for the 15 minutes before `at` to PostHog in one batch.
 * Does nothing without POSTHOG_TOKEN. A failed send is logged, not retried.
 */
export async function sendProductEvents(
  env: Env,
  at = new Date(),
  fetcher: typeof fetch = fetch,
): Promise<number> {
  const token = env.POSTHOG_TOKEN;
  if (!token) return 0;
  const until = new Date(at.getTime());
  const since = new Date(until.getTime() - PING_WINDOW_MS);
  const batch = await collectProductEvents(
    createDb(env.DB),
    since,
    until,
    parseGithubIds(env.OPERATOR_PINGS_IGNORE_GITHUB_IDS),
  );
  if (batch.length === 0) return 0;
  try {
    const response = await fetcher(POSTHOG_BATCH_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: token, batch }),
    });
    if (!response.ok) throw new Error(`PostHog answered ${response.status}`);
    return batch.length;
  } catch (error) {
    console.error(
      JSON.stringify({
        msg: "product events not sent",
        events: batch.length,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return 0;
  }
}
