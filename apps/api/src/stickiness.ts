/**
 * Whether a workspace that tried the relay stuck with it, for Admin › Workspaces and the operator
 * pings. Each workflow (by file path, else name) moves through:
 *
 * - trying: the relay has only run on the branch that added it, usually the `connect` PR. Runs on
 *   other branches without it are expected while that PR is open.
 * - adopted: the relay ran on the repo's default branch, or on a second branch (once merged, new
 *   branches carry it, which covers workflows that only run on pull requests).
 * - trial_abandoned: never adopted, and no relayed run for TRIAL_IDLE_MS.
 * - removed: adopted, then REMOVED_AFTER runs on up-to-date code (the default branch, or a branch
 *   first seen after adoption) with no relay at all. Branches cut before the merge never had it,
 *   so they don't count. It goes back to adopted when the workflow relays again.
 *
 * A run is relayed when it had a pick job, wherever the pick sent it (a machine, GitHub, a hosted
 * provider, or nowhere), so a job routed to GitHub never looks like a drop. Only first attempts
 * count: a re-run reuses the earlier pick. The workspace is adopted while any workflow is,
 * removed only once every adopted workflow is, else trying, else trial_abandoned. Moving one
 * workflow off the relay while others stay on it is fine and says nothing.
 *
 * Reads workflow_run (first attempts, kept RAW_RETENTION_DAYS) and workflow_job's picks over the
 * same window, through their time indexes. A workspace whose last relay has aged out of that
 * window has no state.
 */
import { and, eq, gte } from "drizzle-orm";
import { type Db, schema } from "./db/index.ts";
import { DAY_MS, RAW_RETENTION_DAYS } from "./job-timings.ts";

export const TRIAL_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
/** Runs on up-to-date code without the relay that mark an adopted workflow as removed. */
export const REMOVED_AFTER = 3;
/**
 * A run this new may not have its pick recorded yet, so it isn't counted. Picks are written when
 * their job is queued, which is usually within seconds of the run.
 */
export const SETTLE_MS = 10 * 60 * 1000;

export type StickinessState = "trying" | "adopted" | "trial_abandoned" | "removed";

export interface Stickiness {
  state: StickinessState;
  /** When the workspace entered this state. */
  since: string;
  /** The workflow the state is about: the latest relayed, or the last one removed. */
  repository: string;
  workflow: string;
  /** The branch that added the relay, while trying or after the trial was abandoned. */
  branch: string | null;
  lastRelayAt: string;
  /** Removed: runs on up-to-date code without the relay since the last relay. */
  runsWithout: number;
  /** Removed: when we first saw the run that made it so (for the operator ping). */
  removedSeenAt: string | null;
}

export interface StickinessRun {
  installationId: number;
  repositoryId: number;
  repository: string;
  /** The workflow's file. Null for runs stored before paths were: matched to a path by name. */
  workflowPath: string | null;
  workflowName: string;
  branch: string | null;
  /** The repo's default branch as the run saw it. Null for runs stored before it was. */
  defaultBranch: string | null;
  /** When the run started on GitHub, else when we first saw it. */
  startedAt: number;
  /** When we first stored the run. */
  seenAt: number;
  relayed: boolean;
}

interface WorkflowState {
  state: StickinessState;
  since: number;
  repository: string;
  workflow: string;
  branch: string | null;
  lastRelayAt: number;
  runsWithout: number;
  removedSeenAt: number | null;
}

function workflowState(
  runs: StickinessRun[],
  isDefault: (branch: string | null) => boolean,
  branchFirstSeen: Map<string | null, number>,
  now: number,
): WorkflowState | null {
  const relayed = runs.filter((run) => run.relayed);
  const first = relayed[0];
  const last = relayed.at(-1);
  if (!first || !last) return null;
  const base = {
    repository: first.repository,
    workflow: first.workflowName,
    lastRelayAt: last.startedAt,
    runsWithout: 0,
    removedSeenAt: null,
  };
  const adoption = relayed.find((run) => isDefault(run.branch) || run.branch !== first.branch);
  if (!adoption) {
    const idleSince = last.startedAt + TRIAL_IDLE_MS;
    return now >= idleSince
      ? { ...base, state: "trial_abandoned", since: idleSince, branch: first.branch }
      : { ...base, state: "trying", since: first.startedAt, branch: first.branch };
  }
  const without = runs.filter(
    (run) =>
      !run.relayed &&
      run.startedAt > last.startedAt &&
      (isDefault(run.branch) || (branchFirstSeen.get(run.branch) ?? 0) >= adoption.startedAt),
  );
  const tipping = without[REMOVED_AFTER - 1];
  if (tipping) {
    return {
      ...base,
      state: "removed",
      since: tipping.startedAt,
      branch: null,
      runsWithout: without.length,
      removedSeenAt: tipping.seenAt,
    };
  }
  return { ...base, state: "adopted", since: adoption.startedAt, branch: null };
}

const latest = (states: WorkflowState[], key: "since" | "lastRelayAt") =>
  states.reduce((a, b) => (b[key] > a[key] ? b : a));

/** One workspace's state from its workflows' states, or null when it never relayed. */
function rollUp(states: WorkflowState[]): WorkflowState | null {
  const of = (state: StickinessState) => states.filter((s) => s.state === state);
  const adopted = of("adopted");
  if (adopted.length) {
    const since = Math.min(...adopted.map((s) => s.since));
    return { ...latest(adopted, "lastRelayAt"), since };
  }
  const removed = of("removed");
  // Every adopted workflow is removed: the workspace flipped when the last one did.
  if (removed.length) return latest(removed, "since");
  const trying = of("trying");
  if (trying.length) {
    const since = Math.min(...trying.map((s) => s.since));
    return { ...latest(trying, "lastRelayAt"), since };
  }
  const abandoned = of("trial_abandoned");
  return abandoned.length ? latest(abandoned, "since") : null;
}

/** Each installation's stickiness from its first-attempt runs, oldest first or not. */
export function stickinessOf(runs: StickinessRun[], now: number): Map<number, Stickiness> {
  const settled = runs
    .filter((run) => run.seenAt <= now - SETTLE_MS)
    .sort((a, b) => a.startedAt - b.startedAt);
  const result = new Map<number, Stickiness>();
  for (const [installationId, installRuns] of Map.groupBy(settled, (run) => run.installationId)) {
    const states: WorkflowState[] = [];
    for (const repoRuns of Map.groupBy(installRuns, (run) => run.repositoryId).values()) {
      // The repo's newest known default branch; before that was stored, main or master.
      const known = repoRuns.findLast((run) => run.defaultBranch)?.defaultBranch ?? null;
      const isDefault = (branch: string | null) =>
        branch !== null && (known ? branch === known : branch === "main" || branch === "master");
      const branchFirstSeen = new Map<string | null, number>();
      for (const run of repoRuns) {
        if (!branchFirstSeen.has(run.branch)) branchFirstSeen.set(run.branch, run.startedAt);
      }
      // Older runs have only a name: give them the path a newer run of that name has.
      const pathOf = new Map<string, string>();
      for (const run of repoRuns)
        if (run.workflowPath) pathOf.set(run.workflowName, run.workflowPath);
      const workflowOf = (run: StickinessRun) =>
        run.workflowPath ?? pathOf.get(run.workflowName) ?? `name:${run.workflowName}`;
      for (const workflowRuns of Map.groupBy(repoRuns, workflowOf).values()) {
        const state = workflowState(workflowRuns, isDefault, branchFirstSeen, now);
        if (state) states.push(state);
      }
    }
    const state = rollUp(states);
    if (!state) continue;
    result.set(installationId, {
      state: state.state,
      since: new Date(state.since).toISOString(),
      repository: state.repository,
      workflow: state.workflow,
      branch: state.branch,
      lastRelayAt: new Date(state.lastRelayAt).toISOString(),
      runsWithout: state.runsWithout,
      removedSeenAt:
        state.removedSeenAt === null ? null : new Date(state.removedSeenAt).toISOString(),
    });
  }
  return result;
}

/**
 * Every workspace's stickiness by workspace id, from the runs and picks we still keep. Two reads
 * over the retention window: first-attempt runs through workflow_run_updated_idx, and pick run ids
 * through workflow_job_kind_created_idx.
 */
export async function workspaceStickiness(
  db: Db,
  now = Date.now(),
): Promise<Map<string, Stickiness>> {
  const since = new Date(now - RAW_RETENTION_DAYS * DAY_MS);
  const run = schema.workflowRun;
  const job = schema.workflowJob;
  const [runs, picks, workspaces] = await Promise.all([
    db
      .select({
        id: run.id,
        installationId: run.installationId,
        repositoryId: run.repositoryId,
        repository: run.repositoryFullName,
        workflowPath: run.workflowPath,
        workflowName: run.workflowName,
        branch: run.headBranch,
        defaultBranch: run.defaultBranch,
        runStartedAt: run.runStartedAt,
        createdAt: run.createdAt,
      })
      .from(run)
      .where(and(gte(run.githubUpdatedAt, since), eq(run.runAttempt, 1))),
    db
      .selectDistinct({ runId: job.runId })
      .from(job)
      .where(and(eq(job.kind, "pick"), gte(job.githubCreatedAt, since))),
    db
      .select({ id: schema.workspace.id, installationId: schema.workspace.installationId })
      .from(schema.workspace),
  ]);
  const relayed = new Set(picks.map((pick) => pick.runId));
  const byInstallation = stickinessOf(
    runs.map((row) => ({
      installationId: row.installationId,
      repositoryId: row.repositoryId,
      repository: row.repository,
      workflowPath: row.workflowPath,
      workflowName: row.workflowName ?? row.workflowPath ?? "",
      branch: row.branch,
      defaultBranch: row.defaultBranch,
      startedAt: (row.runStartedAt ?? row.createdAt).getTime(),
      seenAt: row.createdAt.getTime(),
      relayed: relayed.has(row.id),
    })),
    now,
  );
  const result = new Map<string, Stickiness>();
  for (const workspace of workspaces) {
    const state = byInstallation.get(workspace.installationId);
    if (state) result.set(workspace.id, state);
  }
  return result;
}
