/**
 * Why a run's jobs failed, for agents (the MCP server's get_run_failures): each failed job's
 * first failed step, whether its runner failed it before any step ran, GitHub's annotations, and
 * a short excerpt of its log around the last error. Logs and annotations come from GitHub when
 * asked, a few calls per failed job, and never more than MAX_JOBS jobs a call. GitHub masks
 * secrets in logs before it stores them.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { type Db, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import { appInstallationToken, jobAnnotations, jobLogTail } from "./github-app.ts";
import { environmentFor, inWorkspace, PICK } from "./job-times.ts";

const timing = schema.jobTiming;

// Failed jobs read per call: each costs a log and an annotations request to GitHub.
export const MAX_JOBS = 5;
// Bytes of each log read from its end, then the excerpt's own limits.
const TAIL_BYTES = 256 * 1024;
export const MAX_LINES = 50;
export const MAX_EXCERPT_CHARS = 8 * 1024;
const MAX_LINE_CHARS = 500;
const MAX_ANNOTATIONS = 10;

export interface JobFailure {
  id: number;
  name: string;
  conclusion: string;
  // Where it ran: a runner's label, such as ubuntu-latest.
  runner: string | null;
  // True when the runner failed the job before any of its steps started.
  runnerFailed: boolean;
  // "3. Run tests", or null when GitHub sent no failed step.
  failedStep: string | null;
  annotations: string[];
  // The log's last lines up to its last error, or null when GitHub no longer has the log.
  log: string[] | null;
}

export interface RunFailures {
  jobs: JobFailure[];
  // Failed jobs left out past MAX_JOBS.
  more: number;
}

// Colour codes: ESC, then "[...m".
// oxlint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;
const TIMESTAMP = /^\d{4}-\d\d-\d\dT[\d:.]+Z ?/;

/**
 * The part of a log worth reading: up to MAX_LINES lines ending at its last `##[error]` line (or
 * its end, when nothing is marked), without timestamps or colour codes, and no more than
 * MAX_EXCERPT_CHARS. The first line can be cut short, since the log is read from its end.
 */
export function logExcerpt(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(TIMESTAMP, "").replace(ANSI, "").slice(0, MAX_LINE_CHARS));
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  const lastError = lines.findLastIndex((line) => line.includes("##[error]"));
  const end = lastError === -1 ? lines.length : lastError + 1;
  const excerpt = lines.slice(Math.max(0, end - MAX_LINES), end);
  let chars = excerpt.reduce((sum, line) => sum + line.length + 1, 0);
  while (chars > MAX_EXCERPT_CHARS && excerpt.length > 1) chars -= excerpt.shift()!.length + 1;
  return excerpt;
}

/** The failed jobs of one of the workspace's run attempts, with what GitHub says about each. */
export async function runFailures(
  db: Db,
  env: Env,
  workspaceId: string,
  run: { repositoryId: number; runId: number; runAttempt: number },
): Promise<RunFailures> {
  const rows = await db
    .select()
    .from(timing)
    .where(
      and(
        eq(timing.runId, run.runId),
        eq(timing.runAttempt, run.runAttempt),
        eq(timing.repositoryId, run.repositoryId),
        inArray(timing.conclusion, ["failure", "timed_out"]),
        inWorkspace(workspaceId),
        sql`not ${PICK}`,
      ),
    )
    .orderBy(timing.completedAt);
  const read = rows.slice(0, MAX_JOBS);
  if (read.length === 0) return { jobs: [], more: 0 };
  const token = await appInstallationToken(env, read[0]!.installationId);
  const jobs = await Promise.all(
    read.map(async (row): Promise<JobFailure> => {
      const repo = row.repositoryFullName;
      const [annotations, log] = await Promise.all([
        jobAnnotations(token, repo, row.id).catch(() => []),
        jobLogTail(token, repo, row.id, TAIL_BYTES).catch(() => null),
      ]);
      const env = row.startedAt ? environmentFor(row.labels, row.runnerGroupName, null) : null;
      return {
        id: row.id,
        name: row.name,
        conclusion: row.conclusion!,
        runner: env?.label ?? null,
        runnerFailed: row.ranSteps === false,
        failedStep: row.failedStep,
        annotations: annotations
          .slice(0, MAX_ANNOTATIONS)
          .map((message) => message.slice(0, MAX_LINE_CHARS)),
        log: log === null ? null : logExcerpt(log),
      };
    }),
  );
  return { jobs, more: rows.length - read.length };
}
