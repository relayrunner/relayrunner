// What a `run` message tells a connected machine about its job, so `relayrunner connect` and the
// Mac app can name it, link to it and show how long it usually takes there. Read from job_timing,
// whose row the job's `queued` webhook writes before the job is claimed.
//
// Database cost: one primary-key read, then typicalJobTime's range of job_timing_job_idx.
import type { RunJob } from "@relayrunner/machine-protocol";
import { eq } from "drizzle-orm";
import { type Db, schema } from "../db/index.ts";
import { typicalJobTime } from "./job-times.ts";

const table = schema.jobTiming;

/** The job's page on GitHub. */
export const jobUrl = (repo: string, runId: number, jobId: number) =>
  `https://github.com/${repo}/actions/runs/${runId}/job/${jobId}`;

/**
 * A job's name and workflow, for a machine's queue (WaitingMessage.queue), or undefined when its
 * row isn't stored yet. One primary-key read.
 */
export async function jobName(
  db: Db,
  jobId: number,
): Promise<{ name: string; workflow?: string } | undefined> {
  const [row] = await db
    .select({ name: table.name, workflow: table.workflowName })
    .from(table)
    .where(eq(table.id, jobId))
    .limit(1);
  if (!row) return undefined;
  return { name: row.name, ...(row.workflow ? { workflow: row.workflow } : {}) };
}

/** The job for a `run` message, or undefined when its row isn't stored yet. */
export async function runJob(
  db: Db,
  workspaceId: string,
  job: { jobId: number; machineId: string },
  now = Date.now(),
): Promise<RunJob | undefined> {
  const [row] = await db
    .select({
      repositoryId: table.repositoryId,
      repo: table.repositoryFullName,
      runId: table.runId,
      runAttempt: table.runAttempt,
      workflow: table.workflowName,
      name: table.name,
    })
    .from(table)
    .where(eq(table.id, job.jobId))
    .limit(1);
  if (!row) return undefined;
  const typical = await typicalJobTime(
    db,
    workspaceId,
    {
      repositoryId: row.repositoryId,
      workflow: row.workflow,
      name: row.name,
      machineId: job.machineId,
    },
    now,
  );
  return {
    name: row.name,
    workflow: row.workflow,
    repo: row.repo,
    url: jobUrl(row.repo, row.runId, job.jobId),
    runAttempt: row.runAttempt,
    typicalMs: typical?.medianMs ?? null,
  };
}
