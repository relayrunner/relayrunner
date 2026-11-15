/**
 * Why a run's jobs failed, for agents (the MCP server's get_run_failures): each failed job's
 * first failed step, whether its runner failed it before any step ran, GitHub's annotations, and
 * a short excerpt of its log around the last error; and one job's, for its panel in History. Logs
 * and annotations come from GitHub when asked, a few calls per failed job, and never more than
 * MAX_JOBS jobs a call. Only someone who can read the repo on GitHub sees them, nothing is stored,
 * and reads stop while the installation is low on API calls. GitHub masks secrets in logs before
 * it stores them.
 */
import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import { type Db, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import { AppError } from "@relayrunner/errors";
import {
  appInstallationToken,
  jobAnnotations,
  jobLogTail,
  rateLimits,
  userCanReadRepo,
} from "./github-app.ts";
import { Recent } from "./recent.ts";
import { userGitHubId } from "./memberships.ts";
import { environmentFor, inWorkspace, PICK } from "./job-times.ts";
import { type FailureCause, failureCauseOf } from "./ai/failure-cause.ts";

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
  // What most likely caused it, from the AI model (src/ai/failure-cause.ts). Null when AI is off
  // for the workspace or couldn't tell.
  cause: FailureCause | null;
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

// The workspace's failed jobs that match `where`, with what readFailure needs.
function failedJobs(db: Db, workspaceId: string, ...where: SQL[]) {
  return db
    .select({
      id: timing.id,
      installationId: timing.installationId,
      repositoryId: timing.repositoryId,
      repositoryFullName: timing.repositoryFullName,
      name: timing.name,
      conclusion: timing.conclusion,
      labels: timing.labels,
      runnerGroupName: timing.runnerGroupName,
      startedAt: timing.startedAt,
      ranSteps: timing.ranSteps,
      failedStep: timing.failedStep,
    })
    .from(timing)
    .where(
      and(...where, inArray(timing.conclusion, ["failure", "timed_out"]), inWorkspace(workspaceId)),
    );
}
type FailedRow = Awaited<ReturnType<typeof failedJobs>>[number];

// What was read lately, reused so opening the same failed job again doesn't ask GitHub again.
// Held in this isolate's memory only, never written anywhere.
const RECENT_MS = 10 * 60_000;
const access = new Recent<string, boolean>(500);
const failures = new Recent<number, Omit<JobFailure, "cause">>(200);

/** Forgets every read kept above, for tests. */
export function forgetRecentFailures() {
  access.clear();
  failures.clear();
}

// Of the installation's hourly API calls, the share log reads leave for routing.
const RESERVE = 0.1;

/**
 * GitHub for one installation, each asked at most once per request: its token, and whether it has
 * calls to spare. Spare means more than RESERVE of its hourly calls left, so reading logs for
 * people never spends what routing needs (GitHub doesn't count calls to /rate_limit).
 */
function installation(env: Env, installationId: number) {
  let token: Promise<string> | undefined;
  let headroom: Promise<void> | undefined;
  const tokenOnce = () => (token ??= appInstallationToken(env, installationId));
  return {
    token: tokenOnce,
    headroom: () =>
      (headroom ??= (async () => {
        const { core } = await rateLimits(await tokenOnce());
        if (core && core.remaining < core.limit * RESERVE)
          throw new AppError("GITHUB_RATE_LIMITED", {
            retryAfter: Math.max(1, Math.ceil((core.reset.getTime() - Date.now()) / 1000)),
          });
      })()),
  };
}
type Installation = ReturnType<typeof installation>;

/**
 * Throws FORBIDDEN unless the signed-in user can read the repo on GitHub themselves: a workspace
 * member isn't always a collaborator on every repo, and a log can hold anything the job printed.
 */
async function requireRepoAccess(db: Db, userId: string, row: FailedRow, github: Installation) {
  const key = `${row.installationId}:${row.repositoryId}:${userId}`;
  const allowed = await access.get(key, RECENT_MS, async () => {
    const githubId = await userGitHubId(db, userId);
    return (
      githubId !== null && userCanReadRepo(await github.token(), row.repositoryFullName, githubId)
    );
  });
  if (!allowed) throw new AppError("FORBIDDEN");
}

// GitHub's notices about runner images, such as "The ubuntu-latest label will migrate to Ubuntu
// 24.04", show on every job with the label and say nothing about why one failed.
const IMAGE_NOTICE = /\b(?:ubuntu|windows|macos)-latest\b.*\b(?:migrat|redirect)/i;

/** One failed job with what GitHub says about it. A log GitHub no longer has is null. */
async function readFailure(
  github: Installation,
  row: FailedRow,
): Promise<Omit<JobFailure, "cause">> {
  const repo = row.repositoryFullName;
  await github.headroom();
  const token = await github.token();
  const [annotations, log] = await Promise.all([
    jobAnnotations(token, repo, row.id).catch(() => []),
    jobLogTail(token, repo, row.id, TAIL_BYTES).catch(() => null),
  ]);
  const where = row.startedAt ? environmentFor(row.labels, row.runnerGroupName, null) : null;
  return {
    id: row.id,
    name: row.name,
    conclusion: row.conclusion!,
    runner: where?.label ?? null,
    runnerFailed: row.ranSteps === false,
    failedStep: row.failedStep,
    annotations: annotations
      .filter((message) => !IMAGE_NOTICE.test(message))
      .slice(0, MAX_ANNOTATIONS)
      .map((message) => message.slice(0, MAX_LINE_CHARS)),
    log: log === null ? null : logExcerpt(log),
  };
}

// A read that came back without its log may have hit a passing error, so it isn't kept. The cause
// is asked for after, since ai_cache already keeps answers and AI can be turned off meanwhile.
async function failureRead(
  env: Env,
  workspaceId: string,
  github: Installation,
  row: FailedRow,
): Promise<JobFailure> {
  const failure = await failures.get(
    row.id,
    RECENT_MS,
    () => readFailure(github, row),
    (read) => read.log !== null,
  );
  return { ...failure, cause: await failureCauseOf(env, workspaceId, failure) };
}

/** The failed jobs of one of the workspace's run attempts, with what GitHub says about each. */
export async function runFailures(
  db: Db,
  env: Env,
  workspaceId: string,
  userId: string,
  run: { repositoryId: number; runId: number; runAttempt: number },
): Promise<RunFailures> {
  const rows = await failedJobs(
    db,
    workspaceId,
    eq(timing.runId, run.runId),
    eq(timing.runAttempt, run.runAttempt),
    eq(timing.repositoryId, run.repositoryId),
    sql`not ${PICK}`,
  ).orderBy(timing.completedAt);
  const read = rows.slice(0, MAX_JOBS);
  if (read.length === 0) return { jobs: [], more: 0 };
  const github = installation(env, read[0]!.installationId);
  await requireRepoAccess(db, userId, read[0]!, github);
  const jobs = await Promise.all(read.map((row) => failureRead(env, workspaceId, github, row)));
  return { jobs, more: rows.length - read.length };
}

/**
 * Why one of the workspace's jobs failed, for its panel in History. Null when the job isn't the
 * workspace's or didn't fail.
 */
export async function jobFailure(
  db: Db,
  env: Env,
  workspaceId: string,
  userId: string,
  jobId: number,
): Promise<JobFailure | null> {
  const [row] = await failedJobs(db, workspaceId, eq(timing.id, jobId)).limit(1);
  if (!row) return null;
  const github = installation(env, row.installationId);
  await requireRepoAccess(db, userId, row, github);
  return failureRead(env, workspaceId, github, row);
}
