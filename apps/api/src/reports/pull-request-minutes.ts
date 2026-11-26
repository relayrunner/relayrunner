/**
 * CI minutes per pull request, for the Usage page's Pull requests view: every job that ran for a
 * pull request, across its pushes and re-runs, summed per pull request with its estimated cost.
 *
 * A job belongs to the pull request its workflow run names (workflow_run.pull_request_number, from
 * the run's pull_requests on GitHub). GitHub leaves that empty for a push to a branch before its
 * pull request opened, and for pull requests from forks, so a run without one is matched by its
 * repo and branch to a pull request another run on that branch named. The default branch is never
 * matched. What's left counts as outside pull requests, per repo.
 *
 * Reads job_timing's own rows, so the window starts no further back than RAW_RETENTION_DAYS.
 */
import { and, eq, gte, isNotNull, lt, ne, sql } from "drizzle-orm";
import { type Db, schema } from "../db/index.ts";
import { loadPriceBook } from "../providers/prices.ts";
import { DAY_MS, RAW_RETENTION_DAYS } from "../time.ts";
import { BILLED_MINUTES, DURATION_MS } from "./job-sql.ts";
import type { Window } from "./report-window.ts";
import { cents, pricePeriods, rateFor, runnerClass } from "./runner-rates.ts";

const job = schema.jobTiming;
const run = schema.workflowRun;

export interface PullRequestMinutes {
  repository: string;
  number: number;
  /** The title of the newest run that named the pull request. */
  title: string | null;
  /** Time its jobs ran, and the part of it from re-runs (attempt 2 and up). */
  minutes: number;
  rerunMinutes: number;
  /** After GitHub rounds each job up to a whole minute. */
  billedMinutes: number;
  /** Estimated USD, after free public-repo minutes. */
  cost: number;
  jobs: number;
  /** Workflow runs, each counted once however many attempts it had. */
  runs: number;
  /** Distinct commits that ran. */
  commits: number;
  /** When its newest job finished, epoch ms. */
  lastAt: number;
}

export interface OutsidePullRequests {
  repository: string;
  minutes: number;
  billedMinutes: number;
  cost: number;
  jobs: number;
}

export interface PullRequestReport {
  /** Where the report starts, epoch ms: the window's start, or as far back as jobs are kept. */
  from: number;
  to: number;
  /** The most minutes first. */
  pullRequests: PullRequestMinutes[];
  /** Jobs no pull request could be found for, per repo, the most minutes first. */
  outside: OutsidePullRequests[];
}

// A pull request's key, and a branch's, within a repo.
const prKey = (repository: string, number: number) => `${repository}#${number}`;
const branchKey = (repository: string, branch: string) => `${repository}\u0000${branch}`;

export async function pullRequestReport(
  db: Db,
  workspaceId: string,
  window: Window,
  now = Date.now(),
): Promise<PullRequestReport> {
  const from = Math.max(window.from, now - RAW_RETENTION_DAYS * DAY_MS);
  const to = window.to;
  const book = await loadPriceBook(db, now);
  const prices = pricePeriods(book, job.completedAt, from, to);

  const counted = and(
    eq(schema.workspace.id, workspaceId),
    gte(job.completedAt, new Date(from)),
    lt(job.completedAt, new Date(to)),
    isNotNull(job.startedAt),
    isNotNull(job.runnerName),
    ne(sql`coalesce(${job.conclusion}, '')`, "skipped"),
  );
  const onDefault = sql<number>`coalesce(${run.headBranch} = ${run.defaultBranch}, 0)`;

  // Sums per pull request or branch, grouped by what prices a job too.
  const sumsQuery = db
    .select({
      period: prices.period,
      repository: job.repositoryFullName,
      number: run.pullRequestNumber,
      branch: run.headBranch,
      onDefault,
      rerun: sql<number>`(${job.runAttempt} > 1)`,
      labels: job.labels,
      runnerGroupName: job.runnerGroupName,
      private: schema.githubRepository.private,
      jobs: sql<number>`count(*)`,
      runMs: sql<number>`sum(${DURATION_MS})`,
      billedMinutes: sql<number>`sum(${BILLED_MINUTES})`,
    })
    .from(job)
    .innerJoin(schema.workspace, eq(schema.workspace.installationId, job.installationId))
    .leftJoin(run, and(eq(run.id, job.runId), eq(run.runAttempt, job.runAttempt)))
    .leftJoin(schema.githubRepository, eq(schema.githubRepository.id, job.repositoryId))
    .where(counted)
    .groupBy(
      ...prices.groupBy,
      job.repositoryFullName,
      run.pullRequestNumber,
      run.headBranch,
      onDefault,
      sql`(${job.runAttempt} > 1)`,
      job.labels,
      job.runnerGroupName,
      schema.githubRepository.private,
    );

  // Runs, commits and the newest title per pull request or branch. The bare title comes from the
  // row holding max(completed_at), as SQLite picks it.
  const lastAt = sql<number>`max(${job.completedAt})`;
  const metaQuery = db
    .select({
      repository: job.repositoryFullName,
      number: run.pullRequestNumber,
      branch: run.headBranch,
      runs: sql<number>`count(distinct ${job.runId})`,
      commits: sql<number>`count(distinct ${run.headSha})`,
      lastAt,
      title: run.displayTitle,
    })
    .from(job)
    .innerJoin(schema.workspace, eq(schema.workspace.installationId, job.installationId))
    .innerJoin(run, and(eq(run.id, job.runId), eq(run.runAttempt, job.runAttempt)))
    .where(and(counted, sql`not ${onDefault}`))
    .groupBy(job.repositoryFullName, run.pullRequestNumber, run.headBranch);

  const [sums, metas] = await Promise.all([sumsQuery, metaQuery]);

  // Each branch's pull request, from runs that named one. The newest wins on a reused branch.
  const prOfBranch = new Map<string, { number: number; lastAt: number }>();
  for (const meta of metas) {
    if (meta.number === null || meta.branch === null) continue;
    const key = branchKey(meta.repository, meta.branch);
    const known = prOfBranch.get(key);
    if (!known || Number(meta.lastAt) > known.lastAt)
      prOfBranch.set(key, { number: meta.number, lastAt: Number(meta.lastAt) });
  }
  const numberOf = (row: {
    repository: string;
    number: number | null;
    branch: string | null;
    onDefault?: number;
  }) =>
    row.number ??
    (row.branch !== null && !row.onDefault
      ? prOfBranch.get(branchKey(row.repository, row.branch))?.number
      : undefined);

  const pullRequests = new Map<string, PullRequestMinutes>();
  const outside = new Map<string, OutsidePullRequests>();
  for (const row of sums) {
    const perMinute = rateFor(
      book,
      runnerClass(row.labels, row.runnerGroupName),
      row.private,
      prices.at(Number(row.period)),
    );
    const minutes = Number(row.runMs) / 60_000;
    const billedMinutes = Number(row.billedMinutes);
    const jobs = Number(row.jobs);
    const cost = billedMinutes * perMinute;
    const number = numberOf(row);
    if (number === undefined) {
      const sum = outside.get(row.repository) ?? {
        repository: row.repository,
        minutes: 0,
        billedMinutes: 0,
        cost: 0,
        jobs: 0,
      };
      sum.minutes += minutes;
      sum.billedMinutes += billedMinutes;
      sum.cost += cost;
      sum.jobs += jobs;
      outside.set(row.repository, sum);
      continue;
    }
    const pr = pullRequestOf(pullRequests, row.repository, number);
    pr.minutes += minutes;
    if (row.rerun) pr.rerunMinutes += minutes;
    pr.billedMinutes += billedMinutes;
    pr.cost += cost;
    pr.jobs += jobs;
  }

  // How each pull request's title was picked, as [named it, when].
  const titleRanks = new Map<string, readonly [number, number]>();
  for (const meta of metas) {
    const number = numberOf(meta);
    if (number === undefined) continue;
    const key = prKey(meta.repository, number);
    const pr = pullRequests.get(key);
    if (!pr) continue;
    pr.runs += Number(meta.runs);
    pr.commits += Number(meta.commits);
    const at = Number(meta.lastAt);
    if (at > pr.lastAt) pr.lastAt = at;
    // A run that named the pull request titles it over a push run's commit message, then the newest.
    const rank = [meta.number === null ? 0 : 1, at] as const;
    const best = titleRanks.get(key) ?? [-1, 0];
    if (meta.title !== null && (rank[0] > best[0] || (rank[0] === best[0] && at >= best[1]))) {
      pr.title = meta.title;
      titleRanks.set(key, rank);
    }
  }

  return {
    from,
    to,
    pullRequests: [...pullRequests.values()]
      .map((pr) => ({
        ...pr,
        minutes: tenths(pr.minutes),
        rerunMinutes: tenths(pr.rerunMinutes),
        cost: cents(pr.cost),
      }))
      .sort((a, b) => b.minutes - a.minutes || b.lastAt - a.lastAt),
    outside: [...outside.values()]
      .map((sum) => ({ ...sum, minutes: tenths(sum.minutes), cost: cents(sum.cost) }))
      .sort((a, b) => b.minutes - a.minutes),
  };
}

function pullRequestOf(
  pullRequests: Map<string, PullRequestMinutes>,
  repository: string,
  number: number,
) {
  const key = prKey(repository, number);
  let pr = pullRequests.get(key);
  if (!pr) {
    pr = {
      repository,
      number,
      title: null,
      minutes: 0,
      rerunMinutes: 0,
      billedMinutes: 0,
      cost: 0,
      jobs: 0,
      runs: 0,
      commits: 0,
      lastAt: 0,
    };
    pullRequests.set(key, pr);
  }
  return pr;
}

const tenths = (value: number) => Math.round(value * 10) / 10;
