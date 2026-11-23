// What a job does, from its name, its workflow's and its runner labels: the first input for
// runner-size and skip advice. The hourly signals task classifies a few new jobs per workspace
// while AI is on for it (classifyJobTypes); job-times.ts adds the answer to each job's row.
import { matrixName, PICK } from "../job-sql.ts";
import { DAY_MS } from "../time.ts";
import type { JobType } from "@relayrunner/api-types";
import { and, eq, gte, sql } from "drizzle-orm";
import { createDb, type Db, schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import { classify, defineClassifier } from "./classify.ts";
import { aiAccess } from "./settings.ts";

export const JOB_TYPES = {
  lint: "Lint, format, type or style checks",
  test: "Unit or integration tests",
  e2e: "End-to-end or browser tests",
  build: "Compiling, bundling or building images or packages",
  deploy: "Deploying, publishing or releasing",
  other: "Anything else, such as labeling, notifications or housekeeping",
} as const satisfies Record<JobType, string>;

type JobInput = { workflow: string; job: string; labels: string[] };

const jobType = defineClassifier({
  feature: "job_type",
  version: 1,
  questions: {
    kind: { type: "choice", instructions: "What does this CI job mostly do?", criteria: JOB_TYPES },
  },
  state: (input: JobInput) => ({
    workflow: input.workflow,
    job: input.job,
    runs_on: input.labels,
  }),
  // A job's name rarely changes what it does, so its answer lasts as long as the cache allows.
  cacheDays: 90,
});

// Jobs seen this recently are worth classifying; at most this many per workspace an hour, so a
// big workspace fills in over a few hours instead of spending its budget at once.
const RECENT_DAYS = 7;
const PER_RUN = 25;

/** "repositoryId\0workflow\0job", the key job_type rows are matched by. */
export const jobTypeKey = (repositoryId: number, workflow: string | null, job: string) =>
  `${repositoryId}\0${workflow ?? ""}\0${matrixName(job) ?? job}`;

// The model runs overconfident, so an answer below this is kept (the job isn't asked about again)
// but not shown.
const SHOWN = 0.7;

/** The workspace's job types by jobTypeKey; null for a job the model wasn't sure about. */
export async function readJobTypes(db: Db, workspaceId: string) {
  const rows = await db
    .select({
      repositoryId: schema.jobType.repositoryId,
      workflow: schema.jobType.workflow,
      job: schema.jobType.job,
      kind: schema.jobType.kind,
      confidence: schema.jobType.confidence,
    })
    .from(schema.jobType)
    .where(eq(schema.jobType.workspaceId, workspaceId));
  return new Map(
    rows.map((row) => [
      jobTypeKey(row.repositoryId, row.workflow, row.job),
      row.confidence >= SHOWN ? (row.kind as JobType) : null,
    ]),
  );
}

/**
 * Classifies up to PER_RUN of the installation's recent jobs that have no type yet. Stops early
 * when AI says no for a reason that won't change this hour (off, budget, rate limit).
 */
export async function classifyJobTypes(env: Env, installationId: number, now = Date.now()) {
  const db = createDb(env.DB);
  const [workspace] = await db
    .select({ id: schema.workspace.id })
    .from(schema.workspace)
    .where(eq(schema.workspace.installationId, installationId));
  if (!workspace || !(await aiAccess(db, workspace.id, "job_type", now))) return 0;

  const timing = schema.jobTiming;
  const [seen, known] = await Promise.all([
    db
      .select({
        repositoryId: timing.repositoryId,
        workflow: timing.workflowName,
        name: timing.name,
        labels: sql<string | null>`max(${timing.labels})`,
      })
      .from(timing)
      .where(
        and(
          eq(timing.installationId, installationId),
          gte(timing.completedAt, new Date(now - RECENT_DAYS * DAY_MS)),
          // A pick only routes its run, and takes its workflow's name, so it reads as that work.
          sql`not ${PICK}`,
        ),
      )
      .groupBy(timing.repositoryId, timing.workflowName, timing.name),
    readJobTypes(db, workspace.id),
  ]);
  const todo = new Map<string, { repositoryId: number } & JobInput>();
  for (const row of seen) {
    const key = jobTypeKey(row.repositoryId, row.workflow, row.name);
    if (known.has(key) || todo.has(key)) continue;
    todo.set(key, {
      repositoryId: row.repositoryId,
      workflow: row.workflow ?? "",
      job: matrixName(row.name) ?? row.name,
      labels: row.labels ? (JSON.parse(row.labels) as string[]) : [],
    });
    if (todo.size >= PER_RUN) break;
  }

  let classified = 0;
  for (const { repositoryId, ...input } of todo.values()) {
    const result = await classify(env, jobType, workspace.id, input, now);
    if (!result.ok) {
      if (result.reason === "failed") continue;
      break;
    }
    await db
      .insert(schema.jobType)
      .values({
        workspaceId: workspace.id,
        repositoryId,
        workflow: input.workflow,
        job: input.job,
        kind: result.answers.kind.choice,
        confidence: result.answers.kind.confidence,
        classifiedAt: new Date(now),
      })
      .onConflictDoNothing();
    classified += 1;
  }
  return classified;
}
