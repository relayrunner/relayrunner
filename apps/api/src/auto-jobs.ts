// Jobs whose relay hands its runner to the Router: `blacksmith: auto`, or a relay with no inputs.
// Each pick of one looks up what the Router page set for the job (its size, a provider to try
// first) and the workspace's default size, turns each `auto` into that provider's label for the
// size, and keeps the job's row fresh so the Router page lists it.
//
// Database cost per auto pick: one upsert on auto_job's identity index (returning the job's
// setting) and one workspace read by primary key, run together.
import { type AutoSize, AUTO_SIZES, DEFAULT_AUTO_SIZE, labelForSize } from "@relayrunner/providers";
import {
  RUNNER_KEYS,
  resolveAutoInputs,
  type RelayInputs,
  type RunnerKey,
} from "@relayrunner/runner-order";
import { and, desc, eq, gte } from "drizzle-orm";
import { z } from "zod";
import { type Db, schema } from "./db/index.ts";
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

export const autoSizeSchema = z
  .number()
  .int()
  .refine((size): size is AutoSize => (AUTO_SIZES as readonly number[]).includes(size), {
    message: `Pick a size of ${AUTO_SIZES.join(", ")} vCPU.`,
  });

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

/**
 * Sets a job's size and first provider. Answers the job and the setting it replaced, or null when
 * the workspace has no such job.
 */
export async function setAutoJob(
  db: Db,
  workspaceId: string,
  id: number,
  setting: AutoJobSetting,
  userId: string,
) {
  const where = and(eq(table.id, id), eq(table.workspaceId, workspaceId));
  const [job] = await db
    .select({
      repository: table.repository,
      workflow: table.workflow,
      relayJob: table.relayJob,
      size: table.size,
      first: table.first,
    })
    .from(table)
    .where(where)
    .limit(1);
  if (!job) return null;
  await db
    .update(table)
    .set({ ...setting, updatedBy: userId, updatedAt: new Date() })
    .where(where);
  const previous = {
    size: job.size,
    first: RUNNER_KEYS.find((key) => key === job.first) ?? null,
  };
  return { job, previous };
}
