import type { ActivityItem, ActivityPage, ActivityStarter, RouteWalk } from "@relayrunner/activity";

// Agent clients cap tool results (Claude Code's is about 25k tokens), and the dashboard's answers
// carry everything a page might render. These cut them down to what an agent reasons over.

const starterName = (starter: ActivityStarter | null | undefined) =>
  starter ? (starter.member?.name ?? starter.login) : undefined;

// Where the walk ended and why earlier steps passed, without the relay's raw label inputs.
function route(walk: RouteWalk | null) {
  if (!walk) return undefined;
  return {
    step: walk.step,
    skipped: walk.skipped.map(({ key, reason, paused, notShared, minutes }) => ({
      key,
      reason,
      ...(paused && { paused }),
      ...(notShared && { notShared: notShared.map((machine) => machine.machine) }),
      ...(minutes && { minutes: `${minutes.usedMinutes}/${minutes.quotaMinutes}` }),
    })),
  };
}

/**
 * One activity entry for an agent: what happened, when, where and how it ended. `detail` keeps the
 * full entry (urls, sha, starters, the walk's label inputs).
 */
export function compactActivityItem(item: ActivityItem) {
  const base = {
    id: item.id,
    type: item.type,
    time: item.occurredAt,
    ...(item.actor && { actor: item.actor.name }),
  };
  if (item.type === "job.routed" && item.job) {
    const { job } = item;
    return {
      ...base,
      repo: job.repository,
      workflow: job.workflow,
      job: job.name,
      runId: job.runId,
      runner: job.runner.type === "machine" ? job.runner.name : job.runner.label,
      runnerName: job.runnerName,
      status: job.status,
      conclusion: job.conclusion,
      route: route(job.walk),
      startedBy: starterName(item.job.starters.startedBy),
    };
  }
  if (item.type === "job.unroutable") {
    const { data } = item;
    return {
      ...base,
      repo: data.repository,
      workflow: data.workflow,
      job: data.job,
      runId: data.runId,
      reason: data.reason,
      route: route(data.walk),
      jobsNotRun: item.jobsNotRun,
      startedBy: starterName(item.starters?.startedBy),
    };
  }
  if (item.type === "check.completed") {
    const { check, repository, pullRequest, conclusion } = item.data;
    return { ...base, repo: repository, check, pullRequest, conclusion };
  }
  return { ...base, ...(item.machine && { machine: item.machine.name }), ...item.data };
}

/**
 * The first `limit` entries of a page. When that cuts the page short, nextBefore points just past
 * the last entry kept (the API pages by event id), so the next call picks up there.
 */
export function compactActivityPage(page: ActivityPage, limit: number, detail: boolean) {
  const items = page.items.slice(0, limit);
  const cut = items.length < page.items.length;
  return {
    items: detail ? items : items.map(compactActivityItem),
    nextBefore: cut ? items[items.length - 1].id : page.nextBefore,
  };
}

// The parts of GET /api/job-times this Worker touches (apps/api/src/job-times.ts).
interface Stat {
  samples: number;
}
interface JobRow {
  name: string;
  byEnvironment: Record<string, Stat>;
  legs?: JobRow[];
}
interface WorkflowRow {
  repository: string;
  workflow: string | null;
  byEnvironment: Record<string, Stat>;
  jobs: JobRow[];
}
interface JobTimesReport {
  environments: { key: string; stat: Stat }[];
  workflows: WorkflowRow[];
}

const sampled = (byEnvironment: Record<string, Stat>) =>
  Object.fromEntries(Object.entries(byEnvironment).filter(([, stat]) => stat.samples > 0));

function sampledJob(job: JobRow): JobRow {
  return {
    ...job,
    byEnvironment: sampled(job.byEnvironment),
    ...(job.legs && { legs: job.legs.map(sampledJob) }),
  };
}

const contains = (value: string | null, part: string | undefined) =>
  !part || (value ?? "").toLowerCase().includes(part.toLowerCase());

/**
 * Job times narrowed to the workflows asked for, without times that have no successful runs behind
 * them, and without the environments nothing left ran on.
 */
export function compactJobTimes<T extends JobTimesReport>(
  report: T,
  { repository, workflow }: { repository?: string; workflow?: string },
) {
  const workflows = report.workflows
    .filter((row) => contains(row.repository, repository) && contains(row.workflow, workflow))
    .map((row) => ({
      ...row,
      byEnvironment: sampled(row.byEnvironment),
      jobs: row.jobs.map(sampledJob).filter((job) => Object.keys(job.byEnvironment).length > 0),
    }))
    .filter((row) => row.jobs.length > 0 || Object.keys(row.byEnvironment).length > 0);
  const used = new Set<string>();
  const collect = (rows: { byEnvironment: Record<string, Stat>; legs?: JobRow[] }[]) => {
    for (const row of rows) {
      for (const key of Object.keys(row.byEnvironment)) used.add(key);
      if (row.legs) collect(row.legs);
    }
  };
  for (const row of workflows) collect([row, ...row.jobs]);
  return {
    ...report,
    environments: report.environments.filter((env) => env.stat.samples > 0 && used.has(env.key)),
    workflows,
  };
}
