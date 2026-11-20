// Blacksmith has no public usage API, so its usage comes from its CLI: `blacksmith usage` and
// `blacksmith jobs list`, run in a container (packages/blacksmith-cli) logged in with the
// workspace's organization token (`blacksmith org-token create`). Both print JSON; the fixtures are
// captured from a real organization.
//
// Blacksmith's billable minutes are minutes times vCPUs, each job rounded up to a whole minute: a
// 24-second job on 4 vCPU bills 4. Cost follows runtime instead. Jobs come with GitHub's job id
// and their billable minutes but no cost or start time, only when they were created and how long
// they ran.
import type { CliRequest } from "@relayrunner/blacksmith-cli/protocol";
import {
  type AdapterContext,
  type BillingAdapter,
  type DailyUsage,
  date,
  type JobUsage,
  num,
  ProviderApiError,
  ProviderAuthError,
  text,
  utcDay,
  type UsageWindow,
} from "./types.ts";

type CliCall = { kind: "verify" } | { kind: "usage"; start: string; end: string };

async function run(ctx: AdapterContext, call: CliCall) {
  if (!ctx.cli) throw new ProviderApiError("the Blacksmith container isn't available here");
  const organization = ctx.options.organization;
  if (!organization) throw new ProviderApiError("no Blacksmith organization is set");
  const response = await ctx.cli({ ...call, token: ctx.token, organization } as CliRequest);
  if (!response.ok)
    throw response.reason === "auth"
      ? new ProviderAuthError(response.message)
      : new ProviderApiError(response.message);
  return response;
}

interface BlacksmithUsage {
  installation?: { installation_name?: string };
  daily?: {
    date?: string;
    billable_minutes?: number;
    runtime_minutes?: number;
    cost_usd?: number;
  }[];
}

interface BlacksmithJob {
  job_id?: string | number;
  run_id?: string | number;
  repository_name?: string;
  job_name?: string;
  runner_label?: string;
  billable_minutes?: number;
  duration_seconds?: number;
  created_at?: string;
}

export function blacksmithDays(usage: BlacksmithUsage): DailyUsage[] {
  return (usage.daily ?? []).flatMap((row): DailyUsage[] => {
    const day = date(row.date ? `${row.date}T00:00:00Z` : undefined);
    if (!day) return [];
    return [
      {
        day: utcDay(day),
        unit: "billable_minutes",
        quantity: num(row.billable_minutes) ?? 0,
        costUsd: num(row.cost_usd),
      },
      {
        day: utcDay(day),
        unit: "runtime_minutes",
        quantity: num(row.runtime_minutes) ?? 0,
        costUsd: null,
      },
    ];
  });
}

export function blacksmithJob(job: BlacksmithJob): JobUsage | null {
  const jobId = job.job_id === undefined ? null : text(String(job.job_id));
  if (!jobId) return null;
  const createdAt = date(job.created_at);
  const duration = num(job.duration_seconds);
  const billable = num(job.billable_minutes);
  return {
    jobId,
    runId: job.run_id === undefined ? null : text(String(job.run_id)),
    repository: text(job.repository_name),
    jobName: text(job.job_name),
    runnerLabel: text(job.runner_label),
    // Blacksmith gives when the job was created, which is as close to its start as it says.
    startedAt: createdAt,
    finishedAt:
      createdAt && duration !== null ? new Date(createdAt.getTime() + duration * 1000) : null,
    billableSeconds: billable === null ? null : billable * 60,
    queueSeconds: null,
    costUsd: null,
  };
}

export const blacksmith: BillingAdapter = {
  async verify(ctx) {
    const { usage } = await run(ctx, { kind: "verify" });
    return { accountName: text((usage as BlacksmithUsage)?.installation?.installation_name) };
  },

  async usage(ctx, window: UsageWindow) {
    const { usage, jobPages } = await run(ctx, {
      kind: "usage",
      start: window.start.toISOString(),
      end: window.end.toISOString(),
    });
    const seen = new Set<string>();
    const jobs: JobUsage[] = [];
    for (const page of jobPages) {
      for (const raw of (page as { jobs?: BlacksmithJob[] })?.jobs ?? []) {
        const job = blacksmithJob(raw);
        // `jobs list` reaches back by whole days, so some jobs are older than the window.
        if (!job || seen.has(job.jobId)) continue;
        if (job.startedAt && job.startedAt < window.start) continue;
        seen.add(job.jobId);
        jobs.push(job);
      }
    }
    return { jobs, days: blacksmithDays(usage as BlacksmithUsage) };
  },
};
