import type { HistoryJob } from "./runs.ts";

/** Jobs from one branch, which a pull request names when one of its runs came from one. */
export type BranchGroup<Job> = {
  key: string;
  repository: string;
  branch: string | null;
  pullRequest: { number: number; title: string | null } | null;
  jobs: Job[];
};

type Groupable = Pick<
  HistoryJob,
  "id" | "repositoryId" | "repository" | "branch" | "pullRequest" | "title"
>;

/**
 * Jobs grouped by repository and branch, so a pull request's pushes and PR runs land together.
 * Groups keep the jobs' order and come in the order of their first job; a job with no known branch
 * is a group of its own.
 */
export function groupByBranch<Job extends Groupable>(jobs: Job[]): BranchGroup<Job>[] {
  const groups = new Map<string, BranchGroup<Job>>();
  for (const job of jobs) {
    const key = job.branch === null ? `job:${job.id}` : `${job.repositoryId}:${job.branch}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, repository: job.repository, branch: job.branch, pullRequest: null, jobs: [] };
      groups.set(key, group);
    }
    // A PR run's title is the PR's; a push's is its commit message, so only a PR run names it.
    if (!group.pullRequest && job.pullRequest !== null) {
      group.pullRequest = { number: job.pullRequest, title: job.title };
    }
    group.jobs.push(job);
  }
  return [...groups.values()];
}
