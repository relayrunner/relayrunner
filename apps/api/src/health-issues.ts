/**
 * Tells operators when something keeps failing in the background, which logs alone don't: a cron
 * task that fails run after run, or an installation's queued task that fails on every try. Each
 * failure is counted on a health_issue row and the next success clears it. The 15-minute cron
 * posts to OPERATOR_SLACK_WEBHOOK_URL and emails OPERATOR_ALERT_EMAIL when an issue passes its
 * kind's threshold, again each day it stays open, and once when it clears.
 */
import { and, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { type Db, createDb, schema } from "./db/index.ts";
import { emailOperators } from "./email.ts";
import type { Env } from "./env.ts";
import { postToWebhook } from "./operator-pings.ts";
import { DAY_MS } from "./time.ts";

/**
 * Failures in a row before operators hear: three runs of a cron task, and both tries of a queued
 * task in two cron runs in a row, so a few minutes of D1 refusing queries stay quiet.
 */
export const HEALTH_ISSUE_KINDS = {
  cron: { threshold: 3 },
  task: { threshold: 4 },
} as const;

export type HealthIssueKind = keyof typeof HEALTH_ISSUE_KINDS;

const issue = schema.healthIssue;
const ERROR_LENGTH = 500;

/** Counts a failure of `key`, opening its issue on the first. */
export async function recordFailure(
  db: Db,
  failure: { key: string; kind: HealthIssueKind; installationId?: number; error: unknown },
  now = new Date(),
) {
  const error = errorText(failure.error);
  await db
    .insert(issue)
    .values({
      key: failure.key,
      kind: failure.kind,
      installationId: failure.installationId ?? null,
      error,
      failures: 1,
      firstFailedAt: now,
      lastFailedAt: now,
    })
    .onConflictDoUpdate({
      target: issue.key,
      set: {
        error,
        lastFailedAt: now,
        // A failure after it cleared, before that was told, starts a new run of failures.
        failures: sql`case when ${issue.clearedAt} is null then ${issue.failures} + 1 else 1 end`,
        firstFailedAt: sql`case when ${issue.clearedAt} is null then ${issue.firstFailedAt} else ${now.getTime()} end`,
        clearedAt: null,
      },
    });
}

/**
 * Marks `key` as working again. Writes nothing when it has no open issue, so callers can say so on
 * every success.
 */
export async function recordSuccess(db: Db, key: string, now = new Date()) {
  await db
    .update(issue)
    .set({ clearedAt: now })
    .where(and(eq(issue.key, key), isNull(issue.clearedAt)));
}

/**
 * Runs `tasks` side by side like Promise.allSettled, recording each one's outcome under
 * `cron:<name>`, and throws the first failure once all have finished.
 */
export async function runCronTasks(db: Db, tasks: Record<string, () => Promise<unknown>>) {
  const names = Object.keys(tasks);
  const results = await Promise.allSettled(names.map((name) => tasks[name]!()));
  await Promise.all(
    results.map((result, index) => {
      const key = `cron:${names[index]}`;
      const recorded =
        result.status === "fulfilled"
          ? recordSuccess(db, key)
          : recordFailure(db, { key, kind: "cron", error: result.reason });
      return recorded.catch((error) =>
        console.error(
          JSON.stringify({ msg: "health issue not recorded", key, error: errorText(error) }),
        ),
      );
    }),
  );
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
}

export type HealthAlert = {
  key: string;
  state: "failing" | "cleared";
  failures: number;
  since: Date;
  error: string;
};

/**
 * The alerts due now, marked as sent: issues past their threshold that weren't told in the last
 * day, and cleared issues that were told (which are then deleted). Cleared issues nobody heard
 * about are deleted quietly.
 */
export async function takeHealthAlerts(db: Db, now = new Date()): Promise<HealthAlert[]> {
  const rows = await db
    .select()
    .from(issue)
    .where(
      or(
        isNotNull(issue.clearedAt),
        isNull(issue.alertedAt),
        lt(issue.alertedAt, new Date(now.getTime() - DAY_MS)),
      ),
    );
  const alerts: HealthAlert[] = [];
  for (const row of rows) {
    const kind = HEALTH_ISSUE_KINDS[row.kind as HealthIssueKind];
    if (row.clearedAt) {
      if (row.alertedAt) alerts.push(alertFor(row, "cleared"));
      await db.delete(issue).where(and(eq(issue.key, row.key), isNotNull(issue.clearedAt)));
    } else if (kind && row.failures >= kind.threshold) {
      alerts.push(alertFor(row, "failing"));
      await db.update(issue).set({ alertedAt: now }).where(eq(issue.key, row.key));
    }
  }
  return alerts;
}

function alertFor(row: typeof issue.$inferSelect, state: HealthAlert["state"]): HealthAlert {
  return {
    key: row.key,
    state,
    failures: row.failures,
    since: row.firstFailedAt,
    error: row.error,
  };
}

/** One line per alert, for Slack. */
export function alertText(alert: HealthAlert) {
  if (alert.state === "cleared") return `:white_check_mark: \`${alert.key}\` is working again.`;
  const failures = alert.failures === 1 ? "1 time" : `${alert.failures} times in a row`;
  return `:rotating_light: \`${alert.key}\` failed ${failures} since ${alert.since.toISOString()}: ${alert.error.replace(/[<>&]/g, "")}`;
}

/** The 15-minute cron's entry: sends what's due to Slack and the operator inbox. */
export async function sendHealthAlerts(env: Env, now = new Date(), fetcher: typeof fetch = fetch) {
  const alerts = await takeHealthAlerts(createDb(env.DB), now);
  if (!alerts.length) return 0;
  console.error(JSON.stringify({ msg: "health alerts", alerts }));
  const text = alerts.map(alertText).join("\n");
  if (env.OPERATOR_SLACK_WEBHOOK_URL) {
    await postToWebhook(env.OPERATOR_SLACK_WEBHOOK_URL, text, fetcher).catch((error) =>
      console.error(JSON.stringify({ msg: "health alert not posted", error: errorText(error) })),
    );
  }
  await emailOperators(env, { template: "health-alert", context: { alerts } });
  return alerts.length;
}

function errorText(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, ERROR_LENGTH);
}
