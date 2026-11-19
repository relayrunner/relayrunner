// What the Router page shows about setup: each workflow that ran in the workspace's repos lately,
// whether its runs went through a relay, and its jobs; the repos the App can see; and the hosted
// provider labels the workspace's jobs ran on. The page's "Route a repo" sheet steps through one
// repo at a time from this.
//
// Database cost: four statements, run together. Three are ranges of job_timing_installation_idx
// over the window, one a lookup of github_repository_installation_idx; none is a scan.
import { hostedProviderOf, type HostedProviderId } from "@relayrunner/providers";
import { sql } from "drizzle-orm";
import { type Db, schema } from "./db/index.ts";
import { installationSettingsUrl } from "./github.ts";
import { DEFAULT_DAYS, inWorkspace, matrixName, PICK } from "./job-times.ts";
import { DAY_MS } from "./job-timings.ts";

const table = schema.jobTiming;
const repo = schema.githubRepository;

/** One workflow in one repo, over the window. */
export interface SetupWorkflow {
  repositoryId: number;
  repository: string;
  workflow: string;
  runs: number;
  /** Runs where at least one job went through a relay. */
  routedRuns: number;
  /** Its jobs, busiest first, with a matrix's legs as one job. */
  jobs: SetupJob[];
}

/** A job in a workflow, by the name GitHub shows, over the window. */
export interface SetupJob {
  name: string;
  /** Matrix legs seen (`test (18)`, `test (20)`), or 1. */
  legs: number;
  /** The runs-on label it asked for, when it asked for one. */
  label: string | null;
  runs: number;
  /** Its average time on a successful run, in whole minutes, or null with none. */
  minutes: number | null;
}

/** A repo the App can see. */
export interface SetupRepo {
  id: number;
  fullName: string;
  private: boolean;
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
  repos: SetupRepo[];
  /** Where an owner changes which repos the App sees, or null with no installation. */
  accessUrl: string | null;
}

export async function routerSetup(
  db: Db,
  workspaceId: string,
  now = Date.now(),
): Promise<RouterSetup> {
  const since = now - DEFAULT_DAYS * DAY_MS;
  const [workflows, labels, jobs, repos, installation] = await Promise.all([
    db.all<{
      repository_id: number;
      repository: string;
      workflow: string;
      runs: number;
      routed_runs: number;
    }>(sql`
      with runs as (
        select ${table.repositoryId} as repository_id,
          min(${table.repositoryFullName}) as repository,
          min(${table.workflowName}) as workflow,
          max(${PICK}) as routed
        from ${table}
        where ${inWorkspace(workspaceId)} and ${table.completedAt} >= ${since}
          and ${table.workflowName} is not null
        group by ${table.repositoryId}, ${table.runId}, ${table.runAttempt})
      select repository_id, min(repository) as repository, workflow, count(*) as runs,
        sum(routed) as routed_runs
      from runs
      group by repository_id, workflow`),
    db.all<{ labels: string; jobs: number }>(sql`
      select ${table.labels} as labels, count(*) as jobs
      from ${table}
      where ${inWorkspace(workspaceId)} and ${table.completedAt} >= ${since}
        and json_array_length(${table.labels}) = 1 and coalesce(${table.conclusion}, '') <> 'skipped'
      group by ${table.labels}`),
    db.all<{
      repository_id: number;
      workflow: string;
      name: string;
      label: string;
      runs: number;
      ms: number | null;
    }>(sql`
      select ${table.repositoryId} as repository_id, ${table.workflowName} as workflow,
        ${table.name} as name, max(${table.labels}) as label, count(*) as runs,
        avg(case when ${table.conclusion} = 'success'
          then ${table.completedAt} - ${table.startedAt} end) as ms
      from ${table}
      where ${inWorkspace(workspaceId)} and ${table.completedAt} >= ${since}
        and ${table.workflowName} is not null and not ${PICK}
        and coalesce(${table.conclusion}, '') <> 'skipped'
      group by ${table.repositoryId}, ${table.workflowName}, ${table.name}`),
    db
      .select({
        id: repo.id,
        fullName: repo.fullName,
        private: repo.private,
      })
      .from(repo)
      .where(sql`${inWorkspace(workspaceId, repo.installationId)} and ${repo.removedAt} is null`),
    db
      .select({
        id: schema.githubInstallation.id,
        accountLogin: schema.githubInstallation.accountLogin,
        accountType: schema.githubInstallation.accountType,
      })
      .from(schema.githubInstallation)
      .where(inWorkspace(workspaceId, schema.githubInstallation.id))
      .get(),
  ]);

  const workflowKey = (row: { repository_id: number; workflow: string }) =>
    `${row.repository_id}:${row.workflow}`;
  const jobsByWorkflow = Map.groupBy(jobs, workflowKey);

  return {
    days: DEFAULT_DAYS,
    workflows: workflows
      .map((row) => ({
        repositoryId: row.repository_id,
        repository: row.repository,
        workflow: row.workflow,
        runs: Number(row.runs),
        routedRuns: Number(row.routed_runs),
        jobs: setupJobs(jobsByWorkflow.get(workflowKey(row)) ?? []),
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
    repos: repos.sort((a, b) => a.fullName.localeCompare(b.fullName)),
    accessUrl: installation ? installationSettingsUrl(installation) : null,
  };
}

function setupJobs(
  rows: { name: string; label: string; runs: number; ms: number | null }[],
): SetupJob[] {
  // A matrix's legs (`test (18)`, `test (20)`) are one job in the workflow file.
  const merged = new Map<string, Omit<SetupJob, "minutes"> & { ms: number | null }>();
  for (const row of rows) {
    const name = matrixName(row.name) ?? row.name;
    const ms = row.ms === null ? null : Number(row.ms);
    const seen = merged.get(name);
    if (!seen) {
      const labels = JSON.parse(row.label) as string[];
      merged.set(name, {
        name,
        legs: 1,
        label: labels.length === 1 ? (labels[0] ?? null) : null,
        runs: Number(row.runs),
        ms,
      });
      continue;
    }
    // Legs run side by side, so the job's runs are its busiest leg's, its time the slowest leg's.
    seen.legs += 1;
    seen.runs = Math.max(seen.runs, Number(row.runs));
    if (ms !== null) seen.ms = Math.max(seen.ms ?? 0, ms);
  }
  return [...merged.values()]
    .map(({ ms, ...job }) => ({
      ...job,
      minutes: ms === null ? null : Math.max(1, Math.round(ms / 60_000)),
    }))
    .sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name));
}
