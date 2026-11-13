// Reads real usage from the third-party providers workspaces connected (provider_connection). The
// hourly cron queues one sync per connection on the installation task queue
// (src/installation-tasks.ts), so connections sync in parallel. Each sync reads from where the last
// one ended, with an overlap for jobs that were still running, and replaces the rows it sees. A
// failure is recorded on the connection for the dashboard rather than thrown: the next hour tries
// again.
import { isBillingProvider, type BillingProviderId } from "@relayrunner/providers";
import { and, eq, isNull, ne, or, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { createDb, type Db, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import { enqueueInstallationTasks } from "./installation-tasks.ts";
import { purgeBefore } from "./job-timings.ts";
import {
  ADAPTERS,
  ProviderAuthError,
  type Usage,
  type UsageWindow,
} from "./provider-billing/index.ts";
import { openToken } from "./provider-tokens.ts";
import { errorMessage } from "./webhook-queue.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
// A first sync reads this far back.
const FIRST_SYNC_MS = 30 * DAY_MS;
// GitHub stops a job after 6 hours, so a job that started before the last sync ended has finished
// by the time this much more has passed.
const OVERLAP_MS = 7 * HOUR_MS;
// Every provider answers at least this far back (Depot's limit is 90 days).
const MAX_WINDOW_MS = 89 * DAY_MS;
export const USAGE_RETENTION_MS = 90 * DAY_MS;

export type ProviderSyncTask = { kind: "provider-sync"; workspaceId: string; provider: string };

export function syncTask(workspaceId: string, provider: string): ProviderSyncTask {
  return { kind: "provider-sync", workspaceId, provider };
}

/** One connection's rows in any of the provider tables. */
export function byConnection(
  table: { workspaceId: SQLiteColumn; provider: SQLiteColumn },
  workspaceId: string,
  provider: string,
): SQL {
  return and(eq(table.workspaceId, workspaceId), eq(table.provider, provider))!;
}

/**
 * The hourly cron: queue a sync of every connection. One whose token the provider refused waits
 * until someone replaces or tests it, rather than asking again every hour.
 */
export async function syncProviderConnections(env: Env) {
  const { workspaceId, provider, failure } = schema.providerConnection;
  const connections = await createDb(env.DB)
    .select({ workspaceId, provider })
    .from(schema.providerConnection)
    .where(or(isNull(failure), ne(failure, "token_rejected")));
  await enqueueInstallationTasks(
    env,
    connections.map((row) => syncTask(row.workspaceId, row.provider)),
  );
}

/** The hourly cron: drop synced usage past retention. */
export async function purgeOldProviderUsage(db: Db, now = new Date()) {
  const cutoff = new Date(now.getTime() - USAGE_RETENTION_MS);
  await purgeBefore(db, schema.providerJobUsage, schema.providerJobUsage.finishedAt, cutoff);
  await purgeBefore(db, schema.providerDailyUsage, schema.providerDailyUsage.day, cutoff);
}

/** Where the next sync starts and ends: after the last, less the overlap, within what providers keep. */
export function syncWindow(syncedThrough: Date | null, now: Date): UsageWindow {
  const start = syncedThrough
    ? syncedThrough.getTime() - OVERLAP_MS
    : now.getTime() - FIRST_SYNC_MS;
  return { start: new Date(Math.max(start, now.getTime() - MAX_WINDOW_MS)), end: now };
}

/** Sync one connection. Never throws for a provider's answer; records it on the row instead. */
export async function syncConnection(
  env: Env,
  workspaceId: string,
  provider: string,
  now = new Date(),
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const db = createDb(env.DB);
  const key = byConnection(schema.providerConnection, workspaceId, provider);
  const [connection] = await db.select().from(schema.providerConnection).where(key).limit(1);
  // Removed since the task was queued, or a provider this version doesn't know.
  if (!connection || !isBillingProvider(provider)) return;

  try {
    const token = await openToken(env, workspaceId, provider, connection.token);
    const window = syncWindow(connection.syncedThrough, now);
    const usage = await ADAPTERS[provider].usage(
      { token, options: connection.options, fetch: fetcher },
      window,
    );
    // The cursor moves in the same batch as the last rows it covers.
    await saveUsage(db, workspaceId, provider, usage, now, [
      db
        .update(schema.providerConnection)
        .set({ syncedThrough: window.end, lastSyncedAt: now, ...NO_FAILURE })
        .where(key),
    ]);
  } catch (error) {
    console.warn(
      JSON.stringify({
        msg: "provider sync failed",
        provider,
        workspaceId,
        error: errorMessage(error),
      }),
    );
    await db
      .update(schema.providerConnection)
      .set({
        failure: error instanceof ProviderAuthError ? "token_rejected" : "error",
        error: errorMessage(error).slice(0, 500),
        failedAt: now,
      })
      .where(key);
  }
}

export const NO_FAILURE = { failure: null, error: null, failedAt: null };

// D1 runs a batch as one transaction; this keeps each one well inside its statement limits.
const BATCH = 50;

type Statement = Parameters<Db["batch"]>[0][number];

/** Upsert a sync's rows, with `after` in the final batch. */
export async function saveUsage(
  db: Db,
  workspaceId: string,
  provider: BillingProviderId,
  { jobs, days }: Usage,
  now: Date,
  after: Statement[] = [],
) {
  const statements = [
    ...jobs.map((job) => {
      const { jobId, ...values } = job;
      return db
        .insert(schema.providerJobUsage)
        .values({ workspaceId, provider, jobId, ...values, syncedAt: now })
        .onConflictDoUpdate({
          target: [
            schema.providerJobUsage.workspaceId,
            schema.providerJobUsage.provider,
            schema.providerJobUsage.jobId,
          ],
          set: { ...values, syncedAt: now },
        });
    }),
    ...days.map((day) =>
      db
        .insert(schema.providerDailyUsage)
        .values({ workspaceId, provider, ...day, syncedAt: now })
        .onConflictDoUpdate({
          target: [
            schema.providerDailyUsage.workspaceId,
            schema.providerDailyUsage.provider,
            schema.providerDailyUsage.day,
            schema.providerDailyUsage.unit,
          ],
          set: { quantity: day.quantity, costUsd: day.costUsd, syncedAt: now },
        }),
    ),
    ...after,
  ];
  for (let i = 0; i < statements.length; i += BATCH) {
    const [first, ...rest] = statements.slice(i, i + BATCH);
    if (first) await db.batch([first, ...rest]);
  }
}
