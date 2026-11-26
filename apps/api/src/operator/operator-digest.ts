/**
 * A daily and a weekly summary for operators in Slack, next to the one-off pings
 * (operator-pings.ts): who arrived, how many workspaces routed jobs, where the jobs went and how
 * much the machines ran, each against the period before. The daily cron (wrangler.jsonc
 * `triggers`) posts yesterday's digest, and on Mondays also last week's. Days run midnight to
 * midnight US Eastern, so the morning digest covers the day operators just had.
 *
 * Our own workspaces and test accounts are left out, as with the pings. Nothing is stored: each
 * digest is read from D1 when it's posted.
 */
import { and, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { type Db, createDb, isMissingTable, schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import { log } from "../log.ts";
import { currentProviders } from "../providers/provider-catalog.ts";
import { DURATION_MS, RAN } from "../reports/job-sql.ts";
import { DAY_MS, HOUR_MS } from "../time.ts";
import { machineMilestones } from "./admin-adoption.ts";
import { internalWorkspaceIds } from "./internal-workspaces.ts";
import { esc, parseGithubIds, postToWebhook, testAccounts } from "./operator-pings.ts";

export const DIGEST_ZONE = "America/New_York";
// How many names a line lists before "and N more".
const NAMES_SHOWN = 5;
const BUSIEST_SHOWN = 3;

export type Period = { since: Date; until: Date };

export type DigestCounts = {
  signups: number;
  installs: string[];
  firstMachines: string[];
  firstMachineRuns: string[];
  macAppUsers: number;
  activeWorkspaces: number;
  /** Jobs routed, by the provider that took them, most first. */
  routed: { step: string; jobs: number }[];
  unroutable: number;
  machines: number;
  machineJobs: number;
  machineMinutes: number;
  busiest: { name: string; jobs: number }[];
};

const partsFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: DIGEST_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
});

// The zone's minutes east of UTC at `ms`.
function zoneOffset(ms: number) {
  const parts: Record<string, string> = {};
  for (const { type, value } of partsFormat.formatToParts(ms)) parts[type] = value;
  const wall = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!);
  return Math.round((wall - ms) / 60_000);
}

/** Midnight in DIGEST_ZONE of the day `ms` falls in, `addDays` days on. */
export function zoneMidnight(ms: number, addDays = 0) {
  const wall = new Date(ms + zoneOffset(ms) * 60_000);
  const midnight = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() + addDays);
  // The offset at the guess, then again at the answer in case a daylight saving change sits between.
  return midnight - zoneOffset(midnight - zoneOffset(midnight) * 60_000) * 60_000;
}

/** Yesterday, and on Mondays also last week (Monday to Sunday), in DIGEST_ZONE. */
export function digestPeriods(at: Date) {
  const today = zoneMidnight(at.getTime());
  const daysBack = (days: number) => ({
    since: new Date(zoneMidnight(today, -days)),
    until: new Date(today),
  });
  const monday = new Date(today + 12 * HOUR_MS).getUTCDay() === 1;
  return { day: daysBack(1), week: monday ? daysBack(7) : null };
}

/** The period of the same length just before. */
export function previousPeriod({ since, until }: Period): Period {
  // Whole days, so a daylight saving change doesn't shift the start off midnight.
  const days = Math.round((until.getTime() - since.getTime()) / DAY_MS);
  return { since: new Date(zoneMidnight(since.getTime(), -days)), until: since };
}

const between = (column: Parameters<typeof gte>[0], { since, until }: Period) =>
  and(gte(column, since), lt(column, until));

/**
 * What every digest in a run shares, read once: who counts as us, and when each workspace got its
 * first machine and its first run on one (machineMilestones, the same dates Admin › Workspaces shows).
 */
export type DigestContext = {
  ours: Set<string>;
  testUsers: Set<string>;
  firstMachine: Map<string, string | null>;
  firstMachineJob: Map<string, string | null>;
  names: Map<string, string>;
};

export async function digestContext(
  db: Db,
  ignoredGithubIds: number[] = [],
): Promise<DigestContext> {
  const [tests, internal, milestones, workspaces] = await Promise.all([
    testAccounts(db, ignoredGithubIds),
    internalWorkspaceIds(db),
    machineMilestones(db),
    db.select({ id: schema.workspace.id, name: schema.workspace.name }).from(schema.workspace),
  ]);
  return {
    ours: new Set([...internal, ...tests.workspaces]),
    testUsers: tests.users,
    firstMachine: milestones.machineAt,
    firstMachineJob: milestones.firstMachineJobAt,
    names: new Map(workspaces.map((row) => [row.id, row.name])),
  };
}

/** What happened in `period`, our own workspaces and test accounts left out. */
export async function collectDigest(
  db: Db,
  period: Period,
  context: DigestContext,
): Promise<DigestCounts> {
  const { ours, testUsers, names } = context;
  const theirs = <T extends { workspaceId: string }>(rows: T[]) =>
    rows.filter((row) => !ours.has(row.workspaceId));
  const job = schema.jobTiming;
  const decisions = schema.routeDecision;

  const [signups, installs, macApp, decided, machineJobs] = await Promise.all([
    db
      .select({ id: schema.user.id, role: schema.user.role })
      .from(schema.user)
      .where(between(schema.user.createdAt, period)),
    db
      .select({ workspaceId: schema.workspace.id, login: schema.githubInstallation.accountLogin })
      .from(schema.workspace)
      .innerJoin(
        schema.githubInstallation,
        eq(schema.githubInstallation.id, schema.workspace.installationId),
      )
      .where(between(schema.workspace.createdAt, period))
      .orderBy(schema.workspace.createdAt),
    db
      .select({ id: schema.macAppFirstUse.userId, role: schema.user.role })
      .from(schema.macAppFirstUse)
      .innerJoin(schema.user, eq(schema.user.id, schema.macAppFirstUse.userId))
      .where(between(schema.macAppFirstUse.firstUsedAt, period))
      .catch((error: unknown) => {
        if (isMissingTable(error)) return [];
        throw error;
      }),
    db
      .select({
        workspaceId: decisions.workspaceId,
        step: decisions.step,
        jobs: sql<number>`count(*)`,
      })
      .from(decisions)
      .where(between(decisions.createdAt, period))
      .groupBy(decisions.workspaceId, decisions.step),
    db
      .select({
        workspaceId: schema.workspace.id,
        machineId: job.machineId,
        jobs: sql<number>`count(*)`,
        ms: sql<number>`sum(${DURATION_MS})`,
      })
      .from(job)
      .innerJoin(schema.workspace, eq(schema.workspace.installationId, job.installationId))
      .where(and(between(job.completedAt, period), isNotNull(job.machineId), RAN))
      .groupBy(schema.workspace.id, job.machineId),
  ]);

  const person = (row: { id: string; role: string | null }) =>
    row.role !== "operator" && !testUsers.has(row.id);
  const firstIn = (milestones: Map<string, string | null>) =>
    [...milestones]
      .filter(([workspaceId, at]) => {
        if (!at || ours.has(workspaceId)) return false;
        const ms = Date.parse(at);
        return ms >= period.since.getTime() && ms < period.until.getTime();
      })
      .map(([workspaceId]) => names.get(workspaceId) ?? workspaceId);

  const routedRows = theirs(decided);
  const routed = new Map<string, number>();
  const byWorkspace = new Map<string, number>();
  let unroutable = 0;
  for (const row of routedRows) {
    const jobs = Number(row.jobs);
    if (row.step === null) {
      unroutable += jobs;
      continue;
    }
    routed.set(row.step, (routed.get(row.step) ?? 0) + jobs);
    byWorkspace.set(row.workspaceId, (byWorkspace.get(row.workspaceId) ?? 0) + jobs);
  }

  const machineRows = theirs(machineJobs);
  return {
    signups: signups.filter(person).length,
    installs: theirs(installs).map((row) => row.login),
    firstMachines: firstIn(context.firstMachine),
    firstMachineRuns: firstIn(context.firstMachineJob),
    macAppUsers: macApp.filter(person).length,
    activeWorkspaces: new Set(routedRows.map((row) => row.workspaceId)).size,
    routed: [...routed]
      .map(([step, jobs]) => ({ step, jobs }))
      .sort((a, b) => b.jobs - a.jobs || a.step.localeCompare(b.step)),
    unroutable,
    machines: new Set(machineRows.map((row) => row.machineId)).size,
    machineJobs: machineRows.reduce((sum, row) => sum + Number(row.jobs), 0),
    machineMinutes: Math.round(machineRows.reduce((sum, row) => sum + Number(row.ms), 0) / 60_000),
    busiest: [...byWorkspace]
      .map(([workspaceId, jobs]) => ({ name: names.get(workspaceId) ?? workspaceId, jobs }))
      .sort((a, b) => b.jobs - a.jobs || a.name.localeCompare(b.name))
      .slice(0, BUSIEST_SHOWN),
  };
}

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const count = (n: number) => compact.format(n);
const plural = (n: number, one: string, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`;

/** " (was 9)" against the period before, or nothing when it's the same. */
function was(now: number, before: number) {
  return now === before ? "" : ` (was ${count(before)})`;
}

function names(list: string[]) {
  const shown = list.slice(0, NAMES_SHOWN).map((name) => `*${esc(name)}*`);
  const more = list.length - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}

function stepName(step: string) {
  if (step === "machine") return "machines";
  return currentProviders().find((provider) => provider.id === step)?.name ?? step;
}

const dateFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: DIGEST_ZONE,
  weekday: "short",
  month: "short",
  day: "numeric",
});
const shortDate = (ms: number) => dateFormat.format(ms);

/** The digest as Slack mrkdwn: a heading, then only the lines with something to say. */
export function formatDigest(
  kind: "daily" | "weekly",
  period: Period,
  now: DigestCounts,
  before: DigestCounts,
) {
  const last = period.until.getTime() - 1;
  const heading =
    kind === "daily"
      ? `:sunrise: *Daily digest* · ${shortDate(last)}`
      : `:calendar: *Weekly digest* · ${shortDate(period.since.getTime())} to ${shortDate(last)}`;

  const arrivals = [
    now.signups > 0 && `${plural(now.signups, "signup")}${was(now.signups, before.signups)}`,
    now.installs.length > 0 &&
      `${plural(now.installs.length, "install")}${was(now.installs.length, before.installs.length)}: ${names(now.installs)}`,
    now.firstMachines.length > 0 && `First machine: ${names(now.firstMachines)}`,
    now.firstMachineRuns.length > 0 && `First run on a machine: ${names(now.firstMachineRuns)}`,
    now.macAppUsers > 0 &&
      `${plural(now.macAppUsers, "person", "people")} started using the Mac app`,
  ].filter((line): line is string => Boolean(line));

  const routedJobs = now.routed.reduce((sum, row) => sum + row.jobs, 0);
  const routedBefore = before.routed.reduce((sum, row) => sum + row.jobs, 0);
  const split = now.routed
    .map((row) => ({ share: Math.round((row.jobs / routedJobs) * 100), step: row.step }))
    .filter((row) => row.share > 0)
    .map((row) => `${row.share}% ${stepName(row.step)}`)
    .join(", ");
  const activity = [
    `${plural(now.activeWorkspaces, "workspace")} routed jobs${was(now.activeWorkspaces, before.activeWorkspaces)}`,
    routedJobs > 0 &&
      `${plural(routedJobs, "job")} routed${was(routedJobs, routedBefore)}${split ? `: ${split}` : ""}`,
    now.unroutable > 0 &&
      `${plural(now.unroutable, "job")} couldn't be routed${was(now.unroutable, before.unroutable)}`,
    now.machines > 0 &&
      `${plural(now.machines, "machine")} ran ${plural(now.machineJobs, "job")}, ${count(now.machineMinutes)} CI minutes${was(now.machineMinutes, before.machineMinutes)}`,
    now.busiest.length > 1 &&
      `Busiest: ${now.busiest.map((row) => `${esc(row.name)} ${count(row.jobs)}`).join(" · ")}`,
  ].filter((line): line is string => Boolean(line));

  return [
    heading,
    arrivals.length
      ? arrivals.map((line) => `• ${line}`).join("\n")
      : "• No new signups or installs",
    activity.map((line) => `• ${line}`).join("\n"),
  ].join("\n");
}

/** One digest for `period`, with the period before it to compare. */
export async function buildDigest(
  db: Db,
  kind: "daily" | "weekly",
  period: Period,
  context: DigestContext,
) {
  const [now, before] = await Promise.all([
    collectDigest(db, period, context),
    collectDigest(db, previousPeriod(period), context),
  ]);
  return formatDigest(kind, period, now, before);
}

/**
 * The daily cron's entry: posts yesterday's digest, and on Mondays last week's after it. Does
 * nothing without OPERATOR_SLACK_WEBHOOK_URL. A failed digest is logged and the other still goes out.
 */
export async function sendOperatorDigests(
  env: Env,
  at = new Date(),
  fetcher: typeof fetch = fetch,
): Promise<number> {
  const url = env.OPERATOR_SLACK_WEBHOOK_URL;
  if (!url) return 0;
  const db = createDb(env.DB);
  const context = await digestContext(db, parseGithubIds(env.OPERATOR_PINGS_IGNORE_GITHUB_IDS));
  const { day, week } = digestPeriods(at);
  const digests = [buildDigest(db, "daily", day, context)];
  if (week) digests.push(buildDigest(db, "weekly", week, context));
  let sent = 0;
  for (const digest of digests) {
    try {
      await postToWebhook(url, await digest, fetcher);
      sent += 1;
    } catch (error) {
      log.error("operator.digest_not_sent", "operator digest not sent", { error });
    }
  }
  return sent;
}
