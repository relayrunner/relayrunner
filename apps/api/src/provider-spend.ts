/**
 * Spend limits on hosted provider steps. Each GitHub account's spend on each priced provider this
 * UTC month is kept in provider_spend_month at list prices (billed whole minutes times the
 * runner's per-minute price), counted when job_timing first records a job finished. A step with a
 * spend limit passes a job on once the job's account has spent its limit, judged per account like
 * the GitHub minutes limit (src/minutes-rule.ts). Jobs still running aren't counted until they
 * finish, so a busy month can go a little past the limit.
 */
import { isProviderId, listRate } from "@relayrunner/providers";
import type { HostedProviderId } from "@relayrunner/providers";
import { and, eq, sql } from "drizzle-orm";
import { type Db, schema } from "./db/index.ts";
import { environmentFor, environmentProvider } from "./job-times.ts";
import { loadPriceBook } from "./prices.ts";

const table = schema.providerSpendMonth;
const MICROS = 1_000_000;

/** The UTC midnight starting `at`'s month. */
export function monthOf(at: number): Date {
  const date = new Date(at);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

/** A job that just finished, as the spend rollup reads it. */
export interface SpentJob {
  installationId: number;
  labels: string[];
  runnerGroupName: string | null;
  startedAt: Date | null;
  completedAt: Date;
}

/** Adds a job that just finished to its account's month on its provider, when it has a price. */
export async function countProviderSpend(db: Db, job: SpentJob) {
  if (!job.startedAt) return;
  const env = environmentFor(job.labels, job.runnerGroupName, null);
  const provider = environmentProvider(env);
  if (!isProviderId(provider) || provider === "github") return;
  const at = job.completedAt.getTime();
  const rate = listRate(await loadPriceBook(db), provider, env.label.toLowerCase(), at);
  if (!rate) return;
  const minutes = Math.max(1, Math.ceil((at - job.startedAt.getTime()) / 60_000));
  const usdMicros = Math.round(minutes * rate * MICROS);
  await db
    .insert(table)
    .values({
      installationId: job.installationId,
      month: monthOf(at),
      provider,
      usdMicros,
      jobs: 1,
    })
    .onConflictDoUpdate({
      target: [table.installationId, table.month, table.provider],
      set: { usdMicros: sql`${table.usdMicros} + ${usdMicros}`, jobs: sql`${table.jobs} + 1` },
    });
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
