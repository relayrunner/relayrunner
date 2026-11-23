// Jobs whose relay hands its runner to the Router: `blacksmith: auto`, or a relay with no inputs.
// Each pick of one looks up what the Router page set for the job (its size, a provider to try
// first) and the workspace's default size, turns each `auto` into that provider's label for the
// size, and keeps the job's row fresh so the Router page lists it.
//
// Database cost per auto pick: one upsert on auto_job's identity index (returning the job's
// setting) and one workspace read by primary key, run together.
import {
  AUTO_SIZE_MESSAGE,
  DEFAULT_AUTO_SIZE,
  isAutoSize,
  labelForSize,
} from "@relayrunner/providers";
import {
  RUNNER_KEYS,
  relayJobFor,
  resolveAutoInputs,
  type RelayInputs,
  type RunnerKey,
} from "@relayrunner/runner-order";
import { and, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { type Db, schema } from "../db/index.ts";
import type { JobContext } from "./routing.ts";

const table = schema.autoJob;

/** The relay's job in its caller workflow: `relay-test` from "relay-test / RelayRunner". */
export function relayJobOf(jobDisplayName: string | null | undefined): string {
  const name = jobDisplayName?.split(" / ")[0]?.trim();
  return name || "relay";
}

export interface AutoPick {
  inputs: RelayInputs;
  size: number;
  first: RunnerKey | null;
}

/**
 * What an auto relay's job runs on: its inputs with each `auto` replaced by a label of the job's
 * size, that size, and the provider to try first. Touches the job's row, adding it on its first
 * pick.
 */
export async function autoPick(
  db: Db,
  job: {
    workspaceId: string;
    repositoryId: number;
    context: JobContext;
    relayJob: string;
  },
  now = Date.now(),
): Promise<AutoPick> {
  const { context } = job;
  const [[setting], [workspace]] = await Promise.all([
    db
      .insert(table)
      .values({
        workspaceId: job.workspaceId,
        repositoryId: job.repositoryId,
        repository: context.repo,
        workflowPath: context.workflowPath ?? context.workflow ?? "",
        workflow: context.workflow,
        relayJob: job.relayJob,
        lastSeenAt: new Date(now),
      })
      .onConflictDoUpdate({
        target: [table.workspaceId, table.repositoryId, table.workflowPath, table.relayJob],
        set: {
          repository: context.repo,
          workflow: context.workflow,
          lastSeenAt: new Date(now),
        },
      })
      .returning({ size: table.size, first: table.first }),
    db
      .select({ autoSize: schema.workspace.autoSize })
      .from(schema.workspace)
      .where(eq(schema.workspace.id, job.workspaceId))
      .limit(1),
  ]);
  const size = setting?.size ?? workspace?.autoSize ?? DEFAULT_AUTO_SIZE;
  const first = RUNNER_KEYS.find((key) => key === setting?.first) ?? null;
  return {
    inputs: resolveAutoInputs(context, (key) => labelForSize(key, size, context.runId)),
    size,
    first,
  };
}

export const autoSizeSchema = z.number().int().refine(isAutoSize, { message: AUTO_SIZE_MESSAGE });

/** What the Router page can set for a job. Null clears a setting back to the default. */
export const autoJobSettingSchema = z.object({
  size: autoSizeSchema.nullable(),
  first: z.enum(RUNNER_KEYS).nullable(),
});
export type AutoJobSetting = z.infer<typeof autoJobSettingSchema>;

/** An auto job as the Router page lists it. */
export interface AutoJob {
  id: number;
  repositoryId: number;
  repository: string;
  workflowPath: string;
  workflow: string | null;
  relayJob: string;
  size: number | null;
  first: RunnerKey | null;
  updatedAt: number | null;
  lastSeenAt: number;
}

// How long a job that stopped running stays on the Router page.
const LISTED_DAYS = 30;

/** The workspace's auto jobs that ran in the last 30 days, by repo, workflow and job. */
export async function listAutoJobs(db: Db, workspaceId: string, now = Date.now()) {
  const rows = await db
    .select()
    .from(table)
    .where(
      and(
        eq(table.workspaceId, workspaceId),
        gte(table.lastSeenAt, new Date(now - LISTED_DAYS * 86_400_000)),
      ),
    )
    .orderBy(table.repository, table.workflowPath, table.relayJob, desc(table.lastSeenAt));
  return rows.map((row): AutoJob => ({
    id: row.id,
    repositoryId: row.repositoryId,
    repository: row.repository,
    workflowPath: row.workflowPath,
    workflow: row.workflow,
    relayJob: row.relayJob,
    size: row.size,
    first: RUNNER_KEYS.find((key) => key === row.first) ?? null,
    updatedAt: row.updatedAt?.getTime() ?? null,
    lastSeenAt: row.lastSeenAt.getTime(),
  }));
}

/** One of the workspace's auto jobs, with its size and first provider, or null. */
export async function getAutoJob(db: Db, workspaceId: string, id: number) {
  const [job] = await db
    .select({
      repositoryId: table.repositoryId,
      repository: table.repository,
      workflow: table.workflow,
      relayJob: table.relayJob,
      size: table.size,
      first: table.first,
    })
    .from(table)
    .where(and(eq(table.id, id), eq(table.workspaceId, workspaceId)))
    .limit(1);
  return job ? { ...job, first: RUNNER_KEYS.find((key) => key === job.first) ?? null } : null;
}

/** Sets a job's size and first provider. */
export async function setAutoJob(
  db: Db,
  workspaceId: string,
  id: number,
  setting: { size: number | null; first: RunnerKey | null },
  userId: string,
) {
  await db
    .update(table)
    .set({ ...setting, updatedBy: userId, updatedAt: new Date() })
    .where(and(eq(table.id, id), eq(table.workspaceId, workspaceId)));
}

/** A size picked for a job before its repo is routed, by the names GitHub shows. */
export const plannedSizesSchema = z.object({
  repositoryId: z.number().int().positive(),
  jobs: z
    .array(z.object({ workflow: z.string().min(1), job: z.string().min(1), size: autoSizeSchema }))
    .min(1)
    .max(50),
});

/**
 * Saves sizes for jobs that don't route yet, as the auto_job rows their first pick will find: the
 * relay `init` writes for job `test` is `relay-test` (relayJobFor), and the workflow's file comes
 * from its recent runs. The rows start with last_seen_at 0, which keeps them off the Router page
 * (listAutoJobs reads the last 30 days) until a pick touches them. Returns the jobs it saved; one with a `name:` of its own, or a workflow with
 * no recorded file, is left for the Router page once it routes.
 */
export async function planAutoJobs(
  db: Db,
  workspaceId: string,
  repo: { id: number; fullName: string },
  jobs: { workflow: string; job: string; size: number }[],
  userId: string,
) {
  const run = schema.workflowRun;
  const paths = await db
    .select({ workflow: run.workflowName, path: sql<string>`max(${run.workflowPath})` })
    .from(run)
    .where(
      and(
        eq(run.repositoryId, repo.id),
        inArray(run.workflowName, [...new Set(jobs.map((job) => job.workflow))]),
        isNotNull(run.workflowPath),
      ),
    )
    .groupBy(run.workflowName);
  const pathOf = new Map(paths.map((row) => [row.workflow, row.path]));
  const planned = jobs.flatMap((job) => {
    const workflowPath = pathOf.get(job.workflow);
    const relayJob = relayJobFor(job.job);
    return workflowPath && relayJob ? [{ ...job, workflowPath, relayJob }] : [];
  });
  const now = new Date();
  // One statement per job, sent as one batch: D1 caps a statement's bound values at 100.
  const [first, ...rest] = planned.map((job) =>
    db
      .insert(table)
      .values({
        workspaceId,
        repositoryId: repo.id,
        repository: repo.fullName,
        workflowPath: job.workflowPath,
        workflow: job.workflow,
        relayJob: job.relayJob,
        size: job.size,
        updatedBy: userId,
        updatedAt: now,
        lastSeenAt: new Date(0),
      })
      .onConflictDoUpdate({
        target: [table.workspaceId, table.repositoryId, table.workflowPath, table.relayJob],
        set: { size: job.size, updatedBy: userId, updatedAt: now },
      }),
  );
  if (first) await db.batch([first, ...rest]);
  return planned;
}
