// What the Router page shows about setup: each workflow that ran in the workspace's repos lately,
// and whether its runs went through a relay, plus the hosted provider labels the workspace's jobs
// ran on, so the page can show the sizes each job asks for instead of only an example.
//
// Database cost: two statements, run together, each a range of job_timing_installation_idx over
// the window, never a scan.
import { hostedProviderOf, type HostedProviderId } from "@relayrunner/providers";
import { sql } from "drizzle-orm";
import { type Db, schema } from "./db/index.ts";
import { inWorkspace, PICK } from "./job-times.ts";
import { DAY_MS } from "./job-timings.ts";

const table = schema.jobTiming;

/** The window the page reads. */
export const SETUP_DAYS = 14;

/** One workflow in one repo, over the window. */
export interface SetupWorkflow {
  repositoryId: number;
  repository: string;
  workflow: string;
  runs: number;
  /** Runs where at least one job went through a relay. */
  routedRuns: number;
  lastRunAt: number;
}

/** A hosted provider label the workspace's jobs ran on, and how many jobs. */
export interface LabelUse {
  key: HostedProviderId;
  label: string;
  jobs: number;
}

export interface RouterSetup {
  days: number;
  workflows: SetupWorkflow[];
  labels: LabelUse[];
}

export async function routerSetup(db: Db, workspaceId: string, now = Date.now()) {
  const since = now - SETUP_DAYS * DAY_MS;
  const [workflows, labels] = await Promise.all([
    db.all<{
      repository_id: number;
      repository: string;
      workflow: string;
      runs: number;
      routed_runs: number;
      last_run_at: number;
    }>(sql`
      with runs as (
        select ${table.repositoryId} as repository_id,
          min(${table.repositoryFullName}) as repository,
          min(${table.workflowName}) as workflow,
          max(${PICK}) as routed, max(${table.completedAt}) as last_at
        from ${table}
        where ${inWorkspace(workspaceId)} and ${table.completedAt} >= ${since}
          and ${table.workflowName} is not null
        group by ${table.repositoryId}, ${table.runId}, ${table.runAttempt})
      select repository_id, min(repository) as repository, workflow, count(*) as runs,
        sum(routed) as routed_runs, max(last_at) as last_run_at
      from runs
      group by repository_id, workflow`),
    db.all<{ labels: string; jobs: number }>(sql`
      select ${table.labels} as labels, count(*) as jobs
      from ${table}
      where ${inWorkspace(workspaceId)} and ${table.completedAt} >= ${since}
        and json_array_length(${table.labels}) = 1
      group by ${table.labels}`),
  ]);

  const setup: RouterSetup = {
    days: SETUP_DAYS,
    workflows: workflows
      .map((row) => ({
        repositoryId: row.repository_id,
        repository: row.repository,
        workflow: row.workflow,
        runs: Number(row.runs),
        routedRuns: Number(row.routed_runs),
        lastRunAt: Number(row.last_run_at),
      }))
      // Not routed first: those are what's left to set up. Then the busiest.
      .sort(
        (a, b) =>
          Number(a.routedRuns > 0) - Number(b.routedRuns > 0) ||
          b.runs - a.runs ||
          a.repository.localeCompare(b.repository) ||
          a.workflow.localeCompare(b.workflow),
      ),
    labels: labels
      .flatMap((row) => {
        const [label] = JSON.parse(row.labels) as string[];
        const key = hostedProviderOf(label);
        return key ? [{ key, label, jobs: Number(row.jobs) }] : [];
      })
      .sort((a, b) => b.jobs - a.jobs || a.label.localeCompare(b.label)),
  };
  return setup;
}
