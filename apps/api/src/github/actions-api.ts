// Workflow jobs and runs on GitHub: their state, steps, logs and annotations, and re-running,
// cancelling and dispatching them.

import { getJson, getJsonOrNull, githubFetch, listAll, refusalMessage } from "./github-api.ts";

/** A workflow job as GitHub has it now, or null when it's gone. */
async function workflowJob<T>(token: string, repo: string, jobId: number): Promise<T | null> {
  return getJsonOrNull<T>(token, `/repos/${repo}/actions/jobs/${jobId}`);
}

/**
 * A workflow job's status and the runner GitHub gave it (empty until one did), or null when it's
 * gone.
 */
export async function workflowJobRunner(token: string, repo: string, jobId: number) {
  const job = await workflowJob<{ status: string; runner_name: string | null }>(token, repo, jobId);
  return job ? { status: job.status, runnerName: job.runner_name || null } : null;
}

/** An attempt of a run's status ("queued", "in_progress", "completed", ...). */
export async function runAttemptStatus(
  token: string,
  repo: string,
  runId: number,
  runAttempt: number,
): Promise<string> {
  const path = `/repos/${repo}/actions/runs/${runId}/attempts/${runAttempt}`;
  return (await getJson<{ status: string }>(token, path)).status;
}

/** A workflow job's status ("queued", "in_progress", "completed", ...), or null when it's gone. */
export async function workflowJobStatus(token: string, repo: string, jobId: number) {
  return (await workflowJob<{ status: string }>(token, repo, jobId))?.status ?? null;
}

/** One step of a workflow job, as GitHub reports it. Times are epoch ms. */
export interface JobStep {
  number: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: number | null;
  completedAt: number | null;
}

/** A workflow job's steps, or null when GitHub no longer has the job. */
export async function workflowJobSteps(
  token: string,
  repo: string,
  jobId: number,
): Promise<JobStep[] | null> {
  const job = await workflowJob<{
    steps?: {
      number: number;
      name: string;
      status: string;
      conclusion: string | null;
      started_at?: string | null;
      completed_at?: string | null;
    }[];
  }>(token, repo, jobId);
  if (!job) return null;
  const { steps = [] } = job;
  const time = (value?: string | null) => (value ? Date.parse(value) : null);
  return steps.map((step) => ({
    number: step.number,
    name: step.name,
    status: step.status,
    conclusion: step.conclusion,
    startedAt: time(step.started_at),
    completedAt: time(step.completed_at),
  }));
}

/**
 * Who started one attempt of a run (its `triggering_actor`), or null when GitHub doesn't say. For
 * a pick whose context names a re-runner other than the run's actor: the context has no id.
 */
export async function runAttemptTriggeringActor(
  token: string,
  repo: string,
  runId: number,
  runAttempt: number,
): Promise<{ id: number; login: string } | null> {
  const path = `/repos/${repo}/actions/runs/${runId}/attempts/${runAttempt}`;
  const { triggering_actor: actor } = await getJson<{
    triggering_actor?: { id?: unknown; login?: unknown };
  }>(token, path);
  return typeof actor?.id === "number" && typeof actor.login === "string"
    ? { id: actor.id, login: actor.login }
    : null;
}

// A POST whose refusal is GitHub's message rather than an error. Null when GitHub took it.
async function postForMessage(token: string, path: string) {
  const response = await githubFetch(token, path, { method: "POST", allow: "any" });
  if (response.ok) return null;
  return `${response.status}: ${await refusalMessage(response, `POST ${path} failed`)}`;
}

/**
 * Re-runs a job and the jobs that need it, in a new attempt of its run (Actions write). GitHub
 * refuses with 403 while any job of the run is still going. Returns null when GitHub took it, else
 * GitHub's message.
 */
export async function rerunJob(token: string, repo: string, jobId: number): Promise<string | null> {
  return postForMessage(token, `/repos/${repo}/actions/jobs/${jobId}/rerun`);
}

/** A job of one run attempt, as GitHub's jobs API lists it (Actions read). */
export interface AttemptJob {
  id: number;
  name: string;
  run_attempt: number;
  conclusion: string | null;
  labels: string[];
  started_at: string | null;
  completed_at: string | null;
  steps?: { name: string; number: number; conclusion: string | null; started_at: string | null }[];
}

/** The jobs of a run attempt, straight from GitHub. */
export function attemptJobs(token: string, repo: string, runId: number, runAttempt: number) {
  return listAll<AttemptJob>(
    token,
    `/repos/${repo}/actions/runs/${runId}/attempts/${runAttempt}/jobs`,
    "jobs",
  );
}

/**
 * A job's whole log as a stream (Actions read), or null when GitHub doesn't have it: not yet, right
 * after the job finishes, or no longer. Like jobLogTail, fetch follows GitHub's redirect.
 */
export async function jobLog(
  token: string,
  repo: string,
  jobId: number,
): Promise<ReadableStream<Uint8Array> | null> {
  const path = `/repos/${repo}/actions/jobs/${jobId}/logs`;
  const response = await githubFetch(token, path, { allow: [404, 410] });
  if (response.status === 404 || response.status === 410) return null;
  if (!response.body) throw new Error(`GET ${path} had no body`);
  return response.body;
}

/**
 * The end of a job's log (Actions read), at most `maxBytes` of it, or null when GitHub no longer
 * has the log (expired or deleted). GitHub answers with a redirect to the log file, which fetch
 * follows; only the tail is kept while it streams, so a long log never sits in memory whole.
 */
export async function jobLogTail(
  token: string,
  repo: string,
  jobId: number,
  maxBytes: number,
): Promise<string | null> {
  const log = await jobLog(token, repo, jobId);
  if (!log) return null;
  // Keep the last chunks that cover maxBytes, dropping older ones as newer arrive.
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = log.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    while (chunks.length > 1 && size - chunks[0]!.length >= maxBytes)
      size -= chunks.shift()!.length;
  }
  const tail = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    tail.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(tail.subarray(Math.max(0, size - maxBytes)));
}

/** The messages of a job's annotations, where GitHub says a runner was lost (Checks read). */
export async function jobAnnotations(token: string, repo: string, jobId: number) {
  // A job's check run shares its id.
  const annotations = await getJson<{ message?: unknown }[]>(
    token,
    `/repos/${repo}/check-runs/${jobId}/annotations`,
  );
  return annotations.flatMap((a) => (typeof a.message === "string" ? [a.message] : []));
}

/** What GitHub said to a workflow_dispatch: the run it started, or why it refused. */
export type DispatchResult =
  | { ok: true; runId: number | null }
  | { ok: false; status: number; message: string };

/**
 * Starts a workflow on `ref` (Actions write). Asks for the run's details, which GitHub returns
 * since February 2026; `runId` is null when the answer doesn't carry one.
 */
export async function dispatchWorkflow(
  token: string,
  repo: string,
  workflowPath: string,
  ref: string,
): Promise<DispatchResult> {
  const file = encodeURIComponent(workflowPath.split("/").pop() ?? workflowPath);
  const response = await githubFetch(token, `/repos/${repo}/actions/workflows/${file}/dispatches`, {
    method: "POST",
    body: { ref, return_run_details: true },
    allow: "any",
  });
  if (!response.ok)
    return {
      ok: false,
      status: response.status,
      message: await refusalMessage(response, `HTTP ${response.status}`),
    };
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const runId = Number(body?.workflow_run_id ?? body?.id);
  return { ok: true, runId: Number.isSafeInteger(runId) && runId > 0 ? runId : null };
}

/**
 * The newest workflow_dispatch run of a workflow on `branch` created at or after `since`, started
 * by an App (our dispatch), for when the dispatch answer had no run id. Null when none is listed.
 */
export async function findDispatchedRun(
  token: string,
  repo: string,
  workflowPath: string,
  branch: string,
  since: number,
): Promise<number | null> {
  const file = encodeURIComponent(workflowPath.split("/").pop() ?? workflowPath);
  const body = await getJson<{
    workflow_runs?: { id: number; created_at: string; actor?: { type?: string } | null }[];
  }>(
    token,
    `/repos/${repo}/actions/workflows/${file}/runs?event=workflow_dispatch&branch=${encodeURIComponent(branch)}&per_page=10`,
  );
  const run = (body.workflow_runs ?? [])
    .filter((each) => Date.parse(each.created_at) >= since - 5_000 && each.actor?.type === "Bot")
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  return run?.id ?? null;
}

/** Re-runs every job of a finished run as a new attempt (Actions write). Null on success. */
export async function rerunRun(token: string, repo: string, runId: number): Promise<string | null> {
  return postForMessage(token, `/repos/${repo}/actions/runs/${runId}/rerun`);
}

/** Cancels a run's current attempt (Actions write). Null on success or when it already ended. */
export async function cancelRun(
  token: string,
  repo: string,
  runId: number,
): Promise<string | null> {
  const path = `/repos/${repo}/actions/runs/${runId}/cancel`;
  const response = await githubFetch(token, path, { method: "POST", allow: "any" });
  if (response.ok || response.status === 409) return null;
  return `POST ${path} failed with ${response.status}`;
}
