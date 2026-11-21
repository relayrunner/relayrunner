// Groundbox's REST API (https://groundbox.dev/openapi.json) with an API key that has the
// account:read and billing:read scopes.
// - `GET /v1/account` (account:read) gives the team's plan and status, this month's free minutes
//   (`free_minutes.{included,used,left,resets_at}`), balance, spend this month and the spend caps
//   set in Groundbox. The Router reads it before a Groundbox step takes a job (src/groundbox-account.ts).
// - `GET /v1/billing/ledger` (billing:read) lists every charge, newest first, each with its
//   amount, the free minutes it used and the Groundbox CI job it was for. The hourly sync sums it
//   into each job's cost and each day's free minutes. Its jobs are Groundbox's own ids, not
//   GitHub's, and it says what a job cost but not how long it ran.
// Money is in micros (millionths of a dollar).
import {
  type AdapterContext,
  type BillingAdapter,
  type DailyUsage,
  date,
  type JobUsage,
  MAX_PAGES,
  num,
  ProviderApiError,
  requestJson,
  text,
  type UsageWindow,
  utcDay,
} from "./types.ts";

const BASE = "https://api.groundbox.dev/v1";
const MICROS = 1_000_000;

export type GroundboxStatus = "active" | "held" | "suspended";

/** What the Router and the dashboard use of Groundbox's /account answer. */
export interface GroundboxAccount {
  team: string | null;
  plan: string | null;
  status: GroundboxStatus | null;
  // This month's free minutes, or null on a plan without them.
  freeMinutes: { included: number; used: number; left: number; periodStart: string | null } | null;
  // Everything spendable left (plan credit and wallet), in dollars.
  balanceUsd: number | null;
  // CI spend this month, in dollars.
  ciSpentUsd: number | null;
  // The spend caps set in Groundbox, with what they've counted. A null cap is no cap.
  caps: {
    dailyUsd: number | null;
    spentTodayUsd: number;
    monthlyUsd: number | null;
    spentThisMonthUsd: number;
  } | null;
}

type Raw = Record<string, unknown> | null | undefined;
const obj = (value: unknown): Raw =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : null;
const usd = (micros: unknown) => {
  const value = num(micros);
  return value === null ? null : value / MICROS;
};

/** Groundbox's /account answer, read defensively: a field it leaves out is null and never blocks. */
export function parseAccount(body: unknown): GroundboxAccount {
  const root = obj(body);
  const team = obj(root?.team);
  const free = obj(root?.free_minutes);
  const caps = obj(root?.spend_caps);
  const included = num(free?.included);
  const used = num(free?.used);
  const status = text(team?.status);
  return {
    team: text(team?.name),
    plan: text(team?.plan),
    status: status === "active" || status === "held" || status === "suspended" ? status : null,
    freeMinutes:
      included !== null && used !== null
        ? {
            included,
            used,
            left: num(free?.left) ?? Math.max(0, included - used),
            periodStart: text(free?.period_start),
          }
        : null,
    balanceUsd: usd(obj(root?.balance)?.total_micros),
    ciSpentUsd: usd(obj(root?.usage)?.ci_micros),
    caps: caps
      ? {
          dailyUsd: usd(caps.daily_spend_cap_micros),
          spentTodayUsd: usd(caps.spent_today_micros) ?? 0,
          monthlyUsd: usd(caps.monthly_spend_cap_micros),
          spentThisMonthUsd: usd(caps.spent_this_month_micros) ?? 0,
        }
      : null,
  };
}

export async function groundboxAccount(ctx: AdapterContext): Promise<GroundboxAccount> {
  return parseAccount(await requestJson<unknown>(ctx, `${BASE}/account`));
}

interface LedgerEntry {
  kind?: string;
  type?: string;
  bucket?: string;
  amount_micros?: number;
  free_minutes?: number;
  usage?: { kind?: string; ci_job_id?: string | null } | null;
  created_at?: string;
}

/**
 * The ledger's CI charges as jobs (by Groundbox's job id) and days. A job's cost is what was
 * charged to plan credit or the wallet; free minutes cost nothing. A day's row is the free minutes
 * CI used that day, with what CI was charged.
 */
export function ledgerUsage(
  entries: LedgerEntry[],
  window: UsageWindow,
): {
  jobs: JobUsage[];
  days: DailyUsage[];
} {
  const jobs = new Map<string, JobUsage>();
  const days = new Map<number, DailyUsage>();
  for (const entry of entries) {
    const kind = entry.kind ?? entry.type;
    if (kind !== "usage" && kind !== "free_usage") continue;
    if (entry.usage?.kind !== "ci") continue;
    const at = date(entry.created_at);
    if (!at || at < window.start || at > window.end) continue;
    const charged = entry.bucket === "free" ? 0 : Math.abs(num(entry.amount_micros) ?? 0) / MICROS;
    const freeMinutes = Math.abs(num(entry.free_minutes) ?? 0);

    const dayStart = utcDay(at);
    const day = days.get(dayStart.getTime()) ?? {
      day: dayStart,
      unit: "free_minutes",
      quantity: 0,
      costUsd: 0,
    };
    day.quantity += freeMinutes;
    day.costUsd = (day.costUsd ?? 0) + charged;
    days.set(dayStart.getTime(), day);

    const jobId = text(entry.usage.ci_job_id);
    if (!jobId) continue;
    const job = jobs.get(jobId) ?? {
      jobId,
      runId: null,
      repository: null,
      jobName: null,
      runnerLabel: null,
      startedAt: null,
      finishedAt: at,
      billableSeconds: null,
      queueSeconds: null,
      costUsd: 0,
    };
    job.costUsd = (job.costUsd ?? 0) + charged;
    if (!job.finishedAt || at > job.finishedAt) job.finishedAt = at;
    jobs.set(jobId, job);
  }
  return { jobs: [...jobs.values()], days: [...days.values()] };
}

export const groundbox: BillingAdapter = {
  async verify(ctx) {
    const account = await groundboxAccount(ctx);
    if (!account.team && !account.status)
      throw new ProviderApiError("Groundbox's /account answer had no team");
    return { accountName: account.team };
  },

  async usage(ctx, window) {
    // Whole UTC days, so a sync that starts mid-day doesn't replace a day's total with part of it.
    const whole = { start: utcDay(window.start), end: window.end };
    const entries: LedgerEntry[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = new URLSearchParams({ limit: "200", ...(cursor ? { cursor } : {}) });
      const body = await requestJson<{ data?: LedgerEntry[]; next_cursor?: string | null }>(
        ctx,
        `${BASE}/billing/ledger?${query}`,
      );
      const data = body.data ?? [];
      entries.push(...data);
      cursor = body.next_cursor ?? null;
      // Newest first: once a page ends before the window, the rest is older still.
      const last = date(data.at(-1)?.created_at);
      if (!cursor || data.length === 0 || (last && last < whole.start)) break;
    }
    return ledgerUsage(entries, whole);
  },
};
