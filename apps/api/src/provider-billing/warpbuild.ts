// WarpBuild's REST API with an API key that has the ci scope.
// https://www.warpbuild.com/docs/api/reports/GetCIBilling. Every endpoint is labelled alpha.
// The CI billing report lists each job with what it cost in USD, plus a daily chart.
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
} from "./types.ts";

const BASE = "https://api.warpbuild.com/api/v1";

interface WarpJob {
  vcs_job_id?: string;
  run_id?: string;
  repo?: string;
  job_name?: string;
  runner_label?: string;
  timestamp?: string;
  billed_time?: number;
  total_cost?: number;
}

interface CiBilling {
  chart?: { daily?: { date?: string; total_cost?: number; segments?: { job_count?: number }[] }[] };
  jobs?: { items?: WarpJob[]; page?: number; total_pages?: number };
}

function report(ctx: AdapterContext, window: UsageWindow, page: number, perPage: number) {
  const query = new URLSearchParams({
    start_date: window.start.toISOString(),
    end_date: window.end.toISOString(),
    sort_by: "timestamp",
    sort_order: "asc",
    page: String(page),
    per_page: String(perPage),
  });
  return requestJson<CiBilling>(ctx, `${BASE}/reports/billing/ci?${query}`);
}

// TODO(real key): billed_time is assumed to be seconds; the reference doesn't give its unit.
export function warpJob(job: WarpJob): JobUsage | null {
  const jobId = text(job.vcs_job_id);
  if (!jobId) return null;
  return {
    jobId,
    runId: text(job.run_id),
    repository: text(job.repo),
    jobName: text(job.job_name),
    runnerLabel: text(job.runner_label),
    startedAt: null,
    finishedAt: date(job.timestamp),
    billableSeconds: num(job.billed_time),
    queueSeconds: null,
    costUsd: num(job.total_cost),
  };
}

export function warpDays(chart: CiBilling["chart"]): DailyUsage[] {
  return (chart?.daily ?? []).flatMap((day) => {
    const at = date(day.date ? `${day.date.slice(0, 10)}T00:00:00Z` : undefined);
    if (!at) return [];
    const jobs = (day.segments ?? []).reduce((sum, s) => sum + (num(s.job_count) ?? 0), 0);
    return [{ day: at, unit: "jobs", quantity: jobs, costUsd: num(day.total_cost) }];
  });
}

export const warpbuild: BillingAdapter = {
  async verify(ctx) {
    const now = new Date();
    await report(ctx, { start: new Date(now.getTime() - 86_400_000), end: now }, 1, 1);
    // The report names the organization only by id.
    return { accountName: null };
  },

  async usage(ctx, window: UsageWindow) {
    const jobs: JobUsage[] = [];
    let days: DailyUsage[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const response = await report(ctx, window, page, 200);
      if (page === 1) days = warpDays(response.chart);
      for (const job of response.jobs?.items ?? []) {
        const usage = warpJob(job);
        if (usage) jobs.push(usage);
      }
      if (page >= (response.jobs?.total_pages ?? 0)) return { jobs, days };
    }
    throw new ProviderApiError(`more than ${MAX_PAGES} pages of WarpBuild jobs`);
  },
};
