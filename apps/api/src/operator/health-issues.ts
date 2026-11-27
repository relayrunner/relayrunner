/**
 * Tells operators when something keeps failing in the background, which logs alone don't: a cron
 * task that fails run after run, an installation's queued task that fails on every try, or a
 * workspace integration that broke (src/operator/integration-issues.ts). Each failure is counted on a
 * health_issue row and the next success clears it. The 15-minute cron posts to
 * OPERATOR_SLACK_WEBHOOK_URL and emails OPERATOR_ALERT_EMAIL when an issue passes its kind's
 * threshold, reminds twice over the next week (REMINDER_GAPS_MS) while it stays open, then goes
 * quiet until it clears and breaks again. A workspace's owners and admins get the same schedule
 * for its integrations (src/operator/integration-issues.ts).
 */
import { and, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { type Db, createDb, schema } from "../db/index.ts";
import { emailOperators } from "../email.ts";
import type { Env } from "../env.ts";
import { errorMessage } from "../errors.ts";
import { esc, postToWebhook } from "./operator-pings.ts";
import { DAY_MS } from "../time.ts";
import { log } from "../log.ts";

/**
 * Failures in a row before anyone hears: three runs of a cron task; both tries of a queued task in
 * two cron runs in a row, so a few minutes of D1 refusing queries stay quiet; relays left unclaimed
 * in two sweeps in a row; and a workspace integration at once.
 */
export const HEALTH_ISSUE_KINDS = {
  cron: { threshold: 3 },
  task: { threshold: 4 },
  integration: { threshold: 1 },
  // Relay jobs nobody claimed for over 5 minutes, in two 15-minute sweeps in a row
  // (src/routing/pick-sweep.ts), so relays a deploy cut off and the next sweep rescued stay quiet.
  relays: { threshold: 2 },
} as const;

/**
 * After the first alert, reminders go out 2 days later and 4 days after that (about a week in all),
 * then nothing more for this run of failures. Something left broken, like an App a workspace
 * paused for good, doesn't keep emailing anyone.
 */
export const REMINDER_GAPS_MS = [2 * DAY_MS, 4 * DAY_MS];

export type HealthIssueKind = keyof typeof HEALTH_ISSUE_KINDS;

/** One run of something that can fail: `error` is set when it failed. */
export type Outcome = { key: string; kind: HealthIssueKind; error?: unknown };

const issue = schema.healthIssue;
const ERROR_LENGTH = 500;

/**
 * Records several outcomes in one round trip: failures count toward their issue (opening it on the
 * first), and successes clear theirs. Never throws, since it runs beside the work it records.
 */
export async function recordOutcomes(db: Db, outcomes: Outcome[], now = new Date()) {
  const succeeded = outcomes.filter((outcome) => outcome.error === undefined);
  const statements = [
    ...outcomes
      .filter((outcome) => outcome.error !== undefined)
      .map((outcome) => failureUpsert(db, outcome, now)),
    ...(succeeded.length
      ? [
          db
            .update(issue)
            .set({ clearedAt: now })
            .where(
              and(
                inArray(
                  issue.key,
                  succeeded.map((outcome) => outcome.key),
                ),
                isNull(issue.clearedAt),
              ),
            ),
        ]
      : []),
  ];
  await inOneBatch(db, statements).catch((error) =>
    log.error("operator.health_issues_not_recorded", "health issues not recorded", { error }),
  );
}

// A failure after the issue cleared, before that was told, starts a new run of failures.
function failureUpsert(db: Db, outcome: Outcome, now: Date) {
  const error = errorMessage(outcome.error).slice(0, ERROR_LENGTH);
  const restart = sql`${issue.clearedAt} is not null`;
  return db
    .insert(issue)
    .values({ key: outcome.key, kind: outcome.kind, error, failures: 1, firstFailedAt: now })
    .onConflictDoUpdate({
      target: issue.key,
      set: {
        error,
        failures: sql`case when ${restart} then 1 else ${issue.failures} + 1 end`,
        firstFailedAt: sql`case when ${restart} then ${now.getTime()} else ${issue.firstFailedAt} end`,
        alerts: sql`case when ${restart} then 0 else ${issue.alerts} end`,
        alertedAt: sql`case when ${restart} then null else ${issue.alertedAt} end`,
        clearedAt: null,
      },
    });
}

/**
 * Waits for the cron's tasks, which run side by side, records each one's outcome under
 * `cron:<name>`, and throws the first failure once all have finished.
 */
export async function runCronTasks(db: Db, tasks: Record<string, Promise<unknown>>) {
  const names = Object.keys(tasks);
  const results = await Promise.allSettled(Object.values(tasks));
  await recordOutcomes(
    db,
    results.map((result, index) => ({
      key: `cron:${names[index]}`,
      kind: "cron",
      ...(result.status === "rejected" && { error: result.reason ?? "failed" }),
    })),
  );
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
}

export type HealthAlert = {
  key: string;
  kind: HealthIssueKind;
  state: "failing" | "cleared";
  /** A failing alert after the first one for this run of failures. */
  reminder: boolean;
  failures: number;
  since: Date;
  error: string;
};

/**
 * The alerts due now, marked as sent: issues past their threshold that are due their first alert or
 * a reminder, and cleared issues that were told (which are then deleted). Cleared issues nobody
 * heard about are deleted quietly.
 */
export async function takeHealthAlerts(db: Db, now = new Date()): Promise<HealthAlert[]> {
  const rows = await db
    .select()
    .from(issue)
    .where(or(isNotNull(issue.clearedAt), lt(issue.alerts, REMINDER_GAPS_MS.length + 1)));
  const alerts: HealthAlert[] = [];
  const cleared: string[] = [];
  const told: string[] = [];
  for (const row of rows) {
    const kind = row.kind as HealthIssueKind;
    const rules = HEALTH_ISSUE_KINDS[kind];
    const alert = {
      key: row.key,
      kind,
      reminder: row.alerts > 0,
      failures: row.failures,
      since: row.firstFailedAt,
      error: row.error,
    };
    if (row.clearedAt) {
      if (row.alertedAt) alerts.push({ ...alert, state: "cleared" });
      cleared.push(row.key);
    } else if (rules && row.failures >= rules.threshold && due(row, now)) {
      alerts.push({ ...alert, state: "failing" });
      told.push(row.key);
    }
  }
  await inOneBatch(db, [
    ...(cleared.length
      ? [db.delete(issue).where(and(inArray(issue.key, cleared), isNotNull(issue.clearedAt)))]
      : []),
    ...(told.length
      ? [
          db
            .update(issue)
            .set({ alerts: sql`${issue.alerts} + 1`, alertedAt: now })
            .where(inArray(issue.key, told)),
        ]
      : []),
  ]);
  return alerts;
}

// Whether an open issue is due its first alert or its next reminder.
function due(row: { alerts: number; alertedAt: Date | null }, now: Date) {
  if (!row.alertedAt || row.alerts === 0) return true;
  const gap = REMINDER_GAPS_MS[row.alerts - 1];
  return gap !== undefined && now.getTime() - row.alertedAt.getTime() >= gap;
}

// Drizzle's batch takes a non-empty tuple.
async function inOneBatch(db: Db, statements: Parameters<Db["batch"]>[0][number][]) {
  const [first, ...rest] = statements;
  if (first) await db.batch([first, ...rest]);
}

/** One line per alert, for Slack and the operator email alike. */
export function alertLine(alert: HealthAlert) {
  if (alert.state === "cleared") return `${alert.key} is working again.`;
  const reminder = alert.reminder ? "Still broken: " : "";
  if (alert.kind === "relays")
    return `${reminder}Relay jobs aren't being claimed (since ${alert.since.toISOString()}): ${alert.error}`;
  if (alert.kind === "integration")
    return `${reminder}${alert.key}: ${alert.error}. The workspace's owners and admins were emailed.`;
  const failures = alert.failures === 1 ? "1 time" : `${alert.failures} times in a row`;
  return `${reminder}${alert.key} failed ${failures} since ${alert.since.toISOString()}: ${alert.error}`;
}

/**
 * The 15-minute cron's entry: sends what's due to Slack and the operator inbox, and returns the
 * alerts so integration ones can reach their workspaces too.
 */
export async function sendHealthAlerts(env: Env, now = new Date(), fetcher: typeof fetch = fetch) {
  const alerts = await takeHealthAlerts(createDb(env.DB), now);
  if (!alerts.length) return alerts;
  log.error("operator.health_alerts", "health alerts", { alerts });
  const lines = alerts.map(alertLine);
  if (env.OPERATOR_SLACK_WEBHOOK_URL) {
    const text = lines.map((line) => esc(line)).join("\n");
    await postToWebhook(env.OPERATOR_SLACK_WEBHOOK_URL, text, fetcher).catch((error) =>
      log.error("operator.health_alert_not_posted", "health alert not posted", { error }),
    );
  }
  const failing = alerts.filter((alert) => alert.state === "failing").length;
  await emailOperators(env, { template: "health-alert", context: { failing, lines } });
  return alerts;
}
