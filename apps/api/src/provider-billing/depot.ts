// Depot's GitHub Actions API: Connect RPC (JSON over HTTP) with an organization token.
// https://depot.dev/docs/api/github-actions-api and its OpenAPI spec at
// https://depot.dev/openapi/depot-github-actions/v1.json. Jobs carry GitHub's job id, billable
// seconds and queue seconds, but no cost, so cost stays an estimate from list prices.
import {
  type AdapterContext,
  type BillingAdapter,
  date,
  type JobUsage,
  MAX_PAGES,
  num,
  ProviderApiError,
  connectUnary,
  text,
  type UsageWindow,
} from "./types.ts";

const BASE = "https://api.depot.dev/depot.core.v1.GithubActionsService";

const call = <T>(ctx: AdapterContext, method: string, body: unknown) =>
  connectUnary<T>(ctx, `${BASE}/${method}`, body);

interface DepotJob {
  jobId?: string;
  runId?: string;
  repository?: string;
  name?: string;
  runnerLabel?: string;
  startedAt?: string;
  finishedAt?: string;
  billableSeconds?: number | string;
  queueSeconds?: number | string;
}

export function depotJob(job: DepotJob): JobUsage | null {
  const jobId = text(job.jobId);
  if (!jobId) return null;
  return {
    jobId,
    runId: text(job.runId),
    repository: text(job.repository),
    jobName: text(job.name),
    runnerLabel: text(job.runnerLabel),
    startedAt: date(job.startedAt),
    finishedAt: date(job.finishedAt),
    billableSeconds: num(job.billableSeconds),
    queueSeconds: num(job.queueSeconds),
    costUsd: null,
  };
}

export const depot: BillingAdapter = {
  async verify(ctx) {
    const { connections } = await call<{ connections?: { account?: string }[] }>(
      ctx,
      "ListGithubActionsConnections",
      {},
    );
    return { accountName: text(connections?.[0]?.account) };
  },

  async usage(ctx, window: UsageWindow) {
    const jobs: JobUsage[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await call<{ jobs?: DepotJob[]; nextPageToken?: string | null }>(
        ctx,
        "ListGithubActionsJobs",
        {
          timeRange: { startAt: window.start.toISOString(), endAt: window.end.toISOString() },
          statuses: ["GITHUB_ACTIONS_JOB_STATUS_FINISHED"],
          pageSize: 250,
          ...(pageToken ? { pageToken } : {}),
        },
      );
      for (const job of response.jobs ?? []) {
        const usage = depotJob(job);
        if (usage) jobs.push(usage);
      }
      pageToken = response.nextPageToken ?? undefined;
      if (!pageToken) return { jobs, days: [] };
    }
    throw new ProviderApiError(`more than ${MAX_PAGES} pages of Depot jobs`);
  },
};
