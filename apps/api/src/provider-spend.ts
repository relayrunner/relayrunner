/**
 * Spend limits on hosted provider steps. Each GitHub account's spend on each priced provider this
 * UTC month is kept in provider_spend_month at list prices (billed whole minutes times the
 * runner's per-minute price), counted when job_timing first records a job finished. A step with a
 * spend limit passes a job on once the job's account has spent its limit, judged per account like
 * the GitHub minutes limit (src/minutes-rule.ts). Jobs still running aren't counted until they
 * finish, so a busy month can go a little past the limit.
 */
import { hasListPrices, type HostedProviderId, listRate } from "@relayrunner/providers";
import { and, eq, sql } from "drizzle-orm";
import { cycleStart } from "./actions-billing.ts";
import { type Db, schema } from "./db/index.ts";
import { billedMinutes } from "./job-timings.ts";
import { loadPriceBook } from "./prices.ts";
import type { FinishedJob } from "./runner-waits.ts";

const table = schema.providerSpendMonth;
const MICROS = 1_000_000;

/** The UTC midnight starting `at`'s month: the same month the GitHub minutes limit counts. */
export const monthOf = (at: number) => cycleStart(new Date(at));

/**
 * The upsert adding a finished job to its account's month on its provider, or null without a
 * price. Wrapped, since a query builder is thenable and awaiting it would run it.
 */
export async function providerSpendUpsert(db: Db, job: FinishedJob) {
  const { runner, startedAt } = job;
  if (!runner || !startedAt || !hasListPrices(runner.provider)) return null;
  const at = job.completedAt.getTime();
  const book = await loadPriceBook(db);
  const rate = listRate(book, runner.provider as HostedProviderId, runner.label.toLowerCase(), at);
  if (!rate) return null;
  const usdMicros = Math.round(billedMinutes(at - startedAt.getTime()) * rate * MICROS);
  const upsert = db
    .insert(table)
    .values({
      installationId: job.installationId,
      month: monthOf(at),
      provider: runner.provider,
      usdMicros,
      jobs: 1,
    })
    .onConflictDoUpdate({
      target: [table.installationId, table.month, table.provider],
      set: { usdMicros: sql`${table.usdMicros} + ${usdMicros}`, jobs: sql`${table.jobs} + 1` },
    });
  return { upsert };
}

/** What a GitHub account has spent on a provider this month, in dollars, with its login. */
export async function accountSpend(
  db: Db,
  installationId: number,
  provider: HostedProviderId,
  now = Date.now(),
): Promise<{ account: string; spentUsd: number }> {
  const installation = schema.githubInstallation;
  const [row] = await db
    .select({ account: installation.accountLogin, usdMicros: table.usdMicros })
    .from(installation)
    .leftJoin(
      table,
      and(
        eq(table.installationId, installation.id),
        eq(table.month, monthOf(now)),
        eq(table.provider, provider),
      ),
    )
    .where(eq(installation.id, installationId))
    .limit(1);
  return { account: row?.account ?? "", spentUsd: (row?.usdMicros ?? 0) / MICROS };
}
