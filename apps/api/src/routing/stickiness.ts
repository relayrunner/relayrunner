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
 *   first seen after adoption) that finished with no relay at all, for events the relay ran on.
 *   Branches cut before the merge never had it, so they don't count. Nor do events the relay
 *   never ran on (a workflow that only routes its pull requests), runs still going, or runs that
 *   ended before their jobs ran (skipped, cancelled, broken YAML). Since is when the last of those
 *   runs settled and finished. It goes back to adopted when the workflow relays again.
 *
 * A run is relayed when it had a pick job, wherever the pick sent it (a machine, GitHub, a hosted
 * provider, or nowhere), so a job routed to GitHub never looks like a drop. Only first attempts
 * count: a re-run reuses the earlier pick. The workspace is adopted while any workflow is,
 * removed only once every adopted workflow is, else trying, else trial_abandoned. Moving one
 * workflow off the relay while others stay on it is fine and says nothing.
 *
 * Reads workflow_run's first attempts and workflow_job's picks over the last WINDOW_DAYS, through
 * their time indexes. A workspace whose last relay has aged out of that window has no state.
 */
import { DAY_MS } from "../time.ts";
import { and, eq, gte } from "drizzle-orm";
import { type Db, schema } from "../db/index.ts";
import type { Stickiness, StickinessState } from "@relayrunner/api-types";

export type { Stickiness, StickinessState };

/** How far back stickiness reads, every 15 minutes: a month is plenty to see a relay drop out. */
const WINDOW_DAYS = 31;

export const TRIAL_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
/** Runs on up-to-date code without the relay that mark an adopted workflow as removed. */
export const REMOVED_AFTER = 3;
/**
 * A run this new may not have its pick recorded yet, so it isn't counted. Picks are written when
 * their job is queued, which is usually within seconds of the run.
 */
export const SETTLE_MS = 10 * 60 * 1000;
/**
 * Conclusions of a run whose jobs ran, so a missing pick means the relay wasn't there. Others
 * (skipped, cancelled, startup_failure from broken YAML, action_required on a fork) may have ended
 * before any job was queued.
 */
const RAN = new Set(["success", "failure", "timed_out"]);

export interface StickinessRun {
  installationId: number;
  repositoryId: number;
  repository: string;
  /** The workflow's file. Null for runs stored before paths were: matched to a path by name. */
  workflowPath: string | null;
  workflowName: string;
  branch: string | null;
  /** What triggered it: push, pull_request, schedule, ... */
  event: string;
  /** The repo's default branch as the run saw it. Null for runs stored before it was. */
  defaultBranch: string | null;
  /** When the run started on GitHub, else when we first saw it. */
  startedAt: number;
  /** When we first stored the run. */
  seenAt: number;
  /**
   * When GitHub last updated a run that completed after its jobs ran (succeeded, failed or timed
   * out). Null while it's going, or when it ended without running: such a run says nothing about
   * whether the relay is still there.
   */
  finishedAt: number | null;
  relayed: boolean;
}

interface WorkflowState {
  state: StickinessState;
  since: number;
  repository: string;
  workflow: string;
  workflowPath: string | null;
  branch: string | null;
  lastRelayAt: number;
  runsWithout: number;
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
    workflowPath: runs.findLast((run) => run.workflowPath)?.workflowPath ?? null,
    lastRelayAt: last.startedAt,
    runsWithout: 0,
  };
  const adoption = relayed.find((run) => isDefault(run.branch) || run.branch !== first.branch);
  if (!adoption) {
    const idleSince = last.startedAt + TRIAL_IDLE_MS;
    return now >= idleSince
      ? { ...base, state: "trial_abandoned", since: idleSince, branch: first.branch }
      : { ...base, state: "trying", since: first.startedAt, branch: first.branch };
  }
  // Only events the relay ran on count: a workflow may route its pull requests and not its pushes.
  const events = new Set(relayed.map((run) => run.event));
  // When each run without the relay could first count: settled and finished. Later reads never
  // move this earlier, so the operator ping goes out once.
  const countedAt = runs
    .filter(
      (run) =>
        !run.relayed &&
        run.finishedAt !== null &&
        events.has(run.event) &&
        run.startedAt > last.startedAt &&
        (isDefault(run.branch) || (branchFirstSeen.get(run.branch) ?? 0) >= adoption.startedAt),
    )
    .map((run) => Math.max(run.seenAt, run.finishedAt ?? 0) + SETTLE_MS)
    .sort((a, b) => a - b);
  const tipped = countedAt[REMOVED_AFTER - 1];
  if (tipped !== undefined) {
    return {
      ...base,
      state: "removed",
      since: tipped,
      branch: null,
      runsWithout: countedAt.length,
    };
  }
  return { ...base, state: "adopted", since: adoption.startedAt, branch: null };
}

/** Which workflow speaks for the workspace: the first state any workflow is in, in this order. */
const PRECEDENCE: StickinessState[] = ["adopted", "removed", "trying", "trial_abandoned"];

/** One workspace's state from its workflows' states, or null when it never relayed. */
function rollUp(states: WorkflowState[]): WorkflowState | null {
  for (const state of PRECEDENCE) {
    const group = states.filter((s) => s.state === state);
    if (!group.length) continue;
    // Removed: every adopted workflow is, so the workspace flipped when the last one did.
    const key = state === "removed" ? "since" : "lastRelayAt";
    return group.reduce((a, b) => (b[key] > a[key] ? b : a));
  }
  return null;
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
      // The repo's newest known default branch; before that was stored, main or master. Runs from
      // before 2026-11-14 lack it and their path: drop both fallbacks once they age out (2026-12-15).
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
      workflowPath: state.workflowPath,
      branch: state.branch,
      lastRelayAt: new Date(state.lastRelayAt).toISOString(),
      runsWithout: state.runsWithout,
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
  const since = new Date(now - WINDOW_DAYS * DAY_MS);
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
        event: run.event,
        defaultBranch: run.defaultBranch,
        runStartedAt: run.runStartedAt,
        createdAt: run.createdAt,
        status: run.status,
        conclusion: run.conclusion,
        githubUpdatedAt: run.githubUpdatedAt,
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
      event: row.event,
      defaultBranch: row.defaultBranch,
      startedAt: (row.runStartedAt ?? row.createdAt).getTime(),
      seenAt: row.createdAt.getTime(),
      finishedAt:
        row.status === "completed" && RAN.has(row.conclusion ?? "")
          ? row.githubUpdatedAt.getTime()
          : null,
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
