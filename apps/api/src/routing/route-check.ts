// A failed check on the commit when a relay can't be routed. The relay job's own check only says
// it failed after a second, so this one names the reason in its title, where the pull request's
// checks list shows it. A later attempt of the run that routes turns it green.

import { and, eq, isNotNull, lt } from "drizzle-orm";
import { jobCommit } from "../checks/native-checks.ts";
import { type Db, schema } from "../db/index.ts";
import { checkRunsNamed, completeCheckRun } from "../github/repos-api.ts";
import type { FixLink } from "../reports/job-logs.ts";
import { jobContext, noRunnerLead } from "./routing.ts";

export const ROUTE_CHECK_NAME = "RelayRunner: couldn't route";

// GitHub cuts a check run's title off well before its 255-character limit on the checks list.
const TITLE_LENGTH = 120;

export interface RunAttempt {
  repo: string;
  headSha: string;
  runId: number;
  runAttempt: number;
}

/** The run attempt and commit a claimed job's check goes on, or null when the job doesn't say. */
export function routeCheckTarget(contextData: unknown): RunAttempt | null {
  const commit = jobCommit(contextData);
  const context = jobContext(contextData);
  if (!commit || !context) return null;
  return { ...commit, runId: context.runId, runAttempt: context.runAttempt };
}

// Which run attempt posted a check, so a later attempt only clears earlier ones.
const externalId = (run: RunAttempt) => `${run.runId}:${run.runAttempt}`;

/**
 * The failed check: the reason's first clause as its title, then the whole reason, the run, and
 * the page that fixes it.
 */
export function noRouteCheckRun(run: RunAttempt, reason: string, fix?: FixLink) {
  const lead = noRunnerLead(reason);
  const title = lead.length > TITLE_LENGTH ? `${lead.slice(0, TITLE_LENGTH - 1)}…` : lead;
  const runUrl = `https://github.com/${run.repo}/actions/runs/${run.runId}`;
  const summary = [
    `The relay in [this run](${runUrl}) couldn't pick a runner, so the jobs that need it didn't start.`,
    `> ${reason}`,
    fix
      ? `[Open ${fix.name}](${fix.url}) to fix it, then re-run the failed jobs.`
      : "Re-run the failed jobs once it's fixed.",
  ].join("\n\n");
  return {
    name: ROUTE_CHECK_NAME,
    headSha: run.headSha,
    conclusion: "failure" as const,
    title,
    summary,
    externalId: externalId(run),
  };
}

/** Whether an earlier attempt of this run had a relay that couldn't route, and so posted a check. */
export async function hadUnroutableAttempt(
  db: Db,
  { repositoryId, runId, runAttempt }: { repositoryId: number; runId: number; runAttempt: number },
) {
  if (runAttempt <= 1) return false;
  const d = schema.routeDecision;
  const [row] = await db
    .select({ id: d.id })
    .from(d)
    .where(
      and(
        eq(d.repositoryId, repositoryId),
        eq(d.runId, runId),
        lt(d.runAttempt, runAttempt),
        isNotNull(d.reason),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Turns green the failed checks an earlier attempt of this run posted, once a relay in a re-run
 * routes. Call it only when hadUnroutableAttempt says there is one.
 */
export async function clearNoRouteChecks(token: string, run: RunAttempt) {
  const checks = await checkRunsNamed(token, run.repo, run.headSha, ROUTE_CHECK_NAME);
  const earlier = checks.filter((check) => {
    const [runId, attempt] = (check.external_id ?? "").split(":").map(Number);
    return check.conclusion === "failure" && runId === run.runId && attempt < run.runAttempt;
  });
  await Promise.all(
    earlier.map((check) =>
      completeCheckRun(token, run.repo, check.id, {
        conclusion: "success",
        title: `Routed on attempt ${run.runAttempt}`,
        summary: "The relay found a runner when the run was re-run.",
      }),
    ),
  );
}
