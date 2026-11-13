// Who started each job's run, and who re-ran it (#241), for the Activity page. Members sign in with
// GitHub, so a GitHub account id matches a member through their `account` row. Matching happens
// when the log is read, not when the job is kept, so someone who joins later is matched on their
// older runs. Bots and people outside the workspace match no one and show their login.
import type { ActivityStarter, ActivityStarters, GithubActor } from "@relayrunner/activity";
import { and, eq, inArray } from "drizzle-orm";
import { type Db, schema } from "./db/index.ts";
import { actor, type JobPick } from "./route-decisions.ts";

type JobKey = { repositoryId: number; runId: number; runAttempt: number };

/** Who started a run attempt, before matching: from its workflow_run webhook, else its pick. */
export interface RunStarters {
  startedBy: GithubActor | null;
  triggeredBy: GithubActor | null;
}

const runAttemptKey = (repositoryId: number, runId: number, runAttempt: number) =>
  `${repositoryId}:${runId}:${runAttempt}`;

/**
 * Each job's starters, keyed like `jobKey`. The run's workflow_run row for the job's own attempt
 * wins: it also covers a re-run of failed jobs, which doesn't pick again. Without one, the pick's
 * record says who started the run, and who re-ran it only when it picked for this same attempt.
 */
export async function runStartersForJobs(
  db: Db,
  jobs: JobKey[],
  picks: Map<string, Pick<JobPick, "runAttempt" | "startedBy" | "triggeredBy">>,
  keyOf: (job: JobKey) => string,
): Promise<Map<string, RunStarters>> {
  const starters = new Map<string, RunStarters>();
  const runIds = [...new Set(jobs.map((job) => job.runId))];
  if (runIds.length === 0) return starters;
  const run = schema.workflowRun;
  const rows = await db
    .select({
      id: run.id,
      runAttempt: run.runAttempt,
      repositoryId: run.repositoryId,
      startedById: run.startedById,
      startedByLogin: run.startedByLogin,
      triggeredById: run.triggeredById,
      triggeredByLogin: run.triggeredByLogin,
    })
    .from(run)
    .where(inArray(run.id, runIds));
  const runs = new Map(
    rows.map((row) => [runAttemptKey(row.repositoryId, row.id, row.runAttempt), row]),
  );
  for (const job of jobs) {
    const row = runs.get(runAttemptKey(job.repositoryId, job.runId, job.runAttempt));
    const pick = picks.get(keyOf(job));
    const startedBy =
      actor(row?.startedById ?? null, row?.startedByLogin ?? null) ?? pick?.startedBy ?? null;
    const triggeredBy =
      actor(row?.triggeredById ?? null, row?.triggeredByLogin ?? null) ??
      (pick && pick.runAttempt === job.runAttempt ? pick.triggeredBy : null);
    if (startedBy || triggeredBy) starters.set(keyOf(job), { startedBy, triggeredBy });
  }
  return starters;
}

/** The workspace's members by GitHub account id, for the ids given. */
export async function membersByGithubId(
  db: Db,
  workspaceId: string,
  githubIds: number[],
): Promise<Map<number, { id: string; name: string }>> {
  const ids = [...new Set(githubIds)];
  const members = new Map<number, { id: string; name: string }>();
  if (ids.length === 0) return members;
  const rows = await db
    .select({
      accountId: schema.account.accountId,
      id: schema.user.id,
      name: schema.user.name,
    })
    .from(schema.account)
    .innerJoin(schema.user, eq(schema.user.id, schema.account.userId))
    .innerJoin(
      schema.workspaceMember,
      and(
        eq(schema.workspaceMember.userId, schema.account.userId),
        eq(schema.workspaceMember.workspaceId, workspaceId),
      ),
    )
    .where(
      and(
        eq(schema.account.providerId, "github"),
        inArray(
          schema.account.accountId,
          ids.map((id) => String(id)),
        ),
      ),
    );
  for (const row of rows) members.set(Number(row.accountId), { id: row.id, name: row.name });
  return members;
}

/** The GitHub ids a set of starters names, for one membersByGithubId lookup. */
export function githubIds(starters: Iterable<RunStarters>): number[] {
  const ids: number[] = [];
  for (const { startedBy, triggeredBy } of starters)
    for (const who of [startedBy, triggeredBy]) if (who?.id != null) ids.push(who.id);
  return ids;
}

/**
 * As the log shows them. `rerunBy` is set only when someone other than the run's starter started
 * this attempt; a first attempt, or a re-run by the starter, has none.
 */
export function presentStarters(
  starters: RunStarters | undefined,
  members: Map<number, { id: string; name: string }>,
): ActivityStarters {
  const present = (who: GithubActor | null): ActivityStarter | null =>
    who ? { login: who.login, member: (who.id !== null && members.get(who.id)) || null } : null;
  const startedBy = starters?.startedBy ?? null;
  const triggeredBy = starters?.triggeredBy ?? null;
  return {
    startedBy: present(startedBy),
    rerunBy: triggeredBy && !sameActor(startedBy, triggeredBy) ? present(triggeredBy) : null,
  };
}

function sameActor(a: GithubActor | null, b: GithubActor) {
  if (!a) return false;
  if (a.id !== null && b.id !== null) return a.id === b.id;
  return a.login.toLowerCase() === b.login.toLowerCase();
}
