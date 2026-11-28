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
 * When each opened and merged comes from pull_request (src/ingest/pull-requests.ts), which has
 * rows only for pull requests with a delivery since it began; the first job's start stands in for
 * the rest.
 *
 * One repo's pull requests can be asked for, and a page of them in an order; the summary always
 * covers every pull request in the repo (or all repos).
 *
 * Reads job_timing's own rows, so the route keeps the window within RAW_RETENTION_DAYS.
 */
import {
  DEFAULT_PULL_REQUEST_SORT,
  PULL_REQUEST_PAGE,
  type PullRequestMinutes,
  type PullRequestReport,
  pullRequestPage,
  type PullRequestSort,
} from "@relayrunner/api-types";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { type Db, isMissingTable, schema } from "../db/index.ts";
import { loadPriceBook } from "../providers/prices.ts";
import { BILLED_MINUTES, DURATION_MS, RAN_ON_RUNNER } from "./job-sql.ts";
import type { Window } from "./report-window.ts";
import { cents, pricePeriods, rateFor, runnerClass, tenths } from "./runner-rates.ts";

const job = schema.jobTiming;
const run = schema.workflowRun;

/** Which pull requests to list: one repo's (all when not given), in an order, a page at a time. */
export interface PullRequestQuery {
  repository?: string;
  sort?: PullRequestSort;
  offset?: number;
  limit?: number;
}

// A pull request's key, and a branch's, within a repo.
const prKey = (repository: string, number: number) => `${repository}#${number}`;
const branchKey = (repository: string, branch: string) => `${repository}\u0000${branch}`;

type Keyed = { repository: string; number: number | null; branch: string | null };

export async function pullRequestReport(
  db: Db,
  installationId: number,
  { from, to }: Window,
  {
    repository,
    sort = DEFAULT_PULL_REQUEST_SORT,
    offset = 0,
    limit = PULL_REQUEST_PAGE,
  }: PullRequestQuery = {},
  now = Date.now(),
): Promise<PullRequestReport> {
  const book = await loadPriceBook(db, now);
  const prices = pricePeriods(book, job.completedAt, from, to);
  const inWindow = and(
    eq(job.installationId, installationId),
    gte(job.completedAt, new Date(from)),
    lt(job.completedAt, new Date(to)),
    RAN_ON_RUNNER,
  );
  const counted = repository ? and(inWindow, eq(job.repositoryFullName, repository)) : inWindow;
  const offDefault = sql`${run.headBranch} is not ${run.defaultBranch}`;
  // The branch a run without a pull request is matched by: none on the default branch.
  const unnamedBranch = sql<
    string | null
  >`case when ${run.pullRequestNumber} is null and ${offDefault} then ${run.headBranch} end`;

  // Sums per pull request or branch, grouped by what prices a job too.
  const sumsQuery = db
    .select({
      period: prices.period,
      repository: job.repositoryFullName,
      number: run.pullRequestNumber,
      branch: unnamedBranch,
      labels: job.labels,
      runnerGroupName: job.runnerGroupName,
      private: schema.githubRepository.private,
      runMs: sql<number>`sum(${DURATION_MS})`,
      rerunMs: sql<number>`sum(case when ${job.runAttempt} > 1 then ${DURATION_MS} else 0 end)`,
      billedMinutes: sql<number>`sum(${BILLED_MINUTES})`,
      firstAt: sql<number>`min(coalesce(${job.startedAt}, ${job.completedAt}))`,
    })
    .from(job)
    .leftJoin(run, and(eq(run.id, job.runId), eq(run.runAttempt, job.runAttempt)))
    .leftJoin(schema.githubRepository, eq(schema.githubRepository.id, job.repositoryId))
    .where(counted)
    .groupBy(
      ...prices.groupBy,
      job.repositoryFullName,
      run.pullRequestNumber,
      unnamedBranch,
      job.labels,
      job.runnerGroupName,
      schema.githubRepository.private,
    );

  // Per pull request and branch off the default one: its commits, which don't add up across the
  // sums' groups, and its newest run's title, which SQLite takes from the row holding
  // max(completed_at). Named rows also say which pull request each branch belongs to.
  const metaQuery = db
    .select({
      repository: job.repositoryFullName,
      number: run.pullRequestNumber,
      branch: run.headBranch,
      commits: sql<number>`count(distinct ${run.headSha})`,
      lastAt: sql<number>`max(${job.completedAt})`,
      title: run.displayTitle,
    })
    .from(job)
    .innerJoin(run, and(eq(run.id, job.runId), eq(run.runAttempt, job.runAttempt)))
    .where(and(counted, offDefault))
    .groupBy(job.repositoryFullName, run.pullRequestNumber, run.headBranch);

  const datesQuery = db
    .select({
      repository: schema.pullRequest.repositoryFullName,
      number: schema.pullRequest.number,
      openedAt: schema.pullRequest.openedAt,
      mergedAt: schema.pullRequest.mergedAt,
      closedAt: schema.pullRequest.closedAt,
    })
    .from(schema.pullRequest)
    // Only pull requests a run in the window named (the primary key answers each).
    .where(
      sql`(${schema.pullRequest.repositoryId}, ${schema.pullRequest.number}) in (
        select distinct ${job.repositoryId}, ${run.pullRequestNumber} from ${job}
        inner join ${run} on ${run.id} = ${job.runId} and ${run.runAttempt} = ${job.runAttempt}
        where ${counted} and ${run.pullRequestNumber} is not null)`,
    )
    // Before its migration has run, every pull request goes without dates.
    .catch((error) => {
      if (isMissingTable(error)) return [];
      throw error;
    });

  // Every repo that ran jobs in the window, whichever one is asked for: the sums have them all
  // when none is.
  const repositoriesQuery = repository
    ? db.selectDistinct({ repository: job.repositoryFullName }).from(job).where(inWindow)
    : undefined;

  const [sums, metas, dates, otherRepositories] = await Promise.all([
    sumsQuery,
    metaQuery,
    datesQuery,
    repositoriesQuery,
  ]);
  const repositories = otherRepositories?.map((row) => row.repository) ?? [
    ...new Set(sums.map((row) => row.repository)),
  ];
  const datesOf = new Map(dates.map((row) => [prKey(row.repository, row.number), row]));

  // Each branch's pull request, the newest named run winning on a reused branch; and the title of
  // each pull request's newest named run.
  const branches = new Map<string, number>();
  const titles = new Map<string, string | null>();
  for (const meta of metas
    .filter((meta) => meta.number !== null)
    .toSorted((a, b) => Number(a.lastAt) - Number(b.lastAt))) {
    if (meta.branch !== null) branches.set(branchKey(meta.repository, meta.branch), meta.number!);
    titles.set(prKey(meta.repository, meta.number!), meta.title);
  }
  const numberOf = ({ repository, number, branch }: Keyed) =>
    number ?? (branch === null ? undefined : branches.get(branchKey(repository, branch)));

  const pullRequests = new Map<string, PullRequestMinutes>();
  const outside = new Map<string, number>();
  for (const row of sums) {
    const minutes = Number(row.runMs) / 60_000;
    const number = numberOf(row);
    if (number === undefined) {
      outside.set(row.repository, (outside.get(row.repository) ?? 0) + minutes);
      continue;
    }
    const key = prKey(row.repository, number);
    const dates = datesOf.get(key);
    const pr = pullRequests.get(key) ?? {
      repository: row.repository,
      number,
      title: titles.get(key) ?? null,
      minutes: 0,
      rerunMinutes: 0,
      cost: 0,
      commits: 0,
      openedAt: dates?.openedAt?.getTime() ?? null,
      mergedAt: dates?.mergedAt?.getTime() ?? null,
      closedAt: dates?.closedAt?.getTime() ?? null,
      firstRunAt: Number(row.firstAt),
    };
    const cls = runnerClass(row.labels, row.runnerGroupName);
    pr.firstRunAt = Math.min(pr.firstRunAt, Number(row.firstAt));
    pr.minutes += minutes;
    pr.rerunMinutes += Number(row.rerunMs) / 60_000;
    pr.cost +=
      Number(row.billedMinutes) * rateFor(book, cls, row.private, prices.at(Number(row.period)));
    pullRequests.set(key, pr);
  }
  for (const meta of metas) {
    const number = numberOf(meta);
    const pr = number === undefined ? undefined : pullRequests.get(prKey(meta.repository, number));
    if (pr) pr.commits += Number(meta.commits);
  }

  const all = [...pullRequests.values()].map((pr) => ({
    ...pr,
    minutes: tenths(pr.minutes),
    rerunMinutes: tenths(pr.rerunMinutes),
    cost: cents(pr.cost),
  }));
  const outsideRows = [...outside].map(([repository, minutes]) => ({
    repository,
    minutes: tenths(minutes),
  }));
  return {
    ...pullRequestPage(all, outsideRows, { sort, offset, limit }),
    repositories: repositories.sort(),
  };
}
