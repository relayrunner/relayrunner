// Step logs for a job a PickRunner answers itself. GitHub's own runner sends each step's status
// and log to the results service named in the job message; without them the job has annotations
// but `gh run view --log` and the job page's log view find nothing. This sends the same three
// things: the steps, a log per step, and the job's whole log.
//
// The contract is the runner's ResultsHttpClient (actions/runner, src/Sdk/WebApi/WebApi): twirp
// endpoints with snake_case JSON, and a signed blob URL to PUT each log to.

import { userAgent } from "./runner-protocol.ts";

export interface StepLog {
  // The step's id in the job message.
  id: string;
  number: number;
  name: string;
  // Null for a step that never ran, which shows as skipped.
  ok: boolean | null;
  lines: string[];
}

export interface JobLogTarget {
  resultsUrl: string;
  // The job message's system connection token.
  token: string;
  planId: string;
  jobId: string;
}

// The results service's Status and Conclusion enums, which it reads as numbers.
const COMPLETED = 6;
const CONCLUSION = { success: 2, failure: 3, skipped: 7 } as const;

const RECEIVER = "twirp/results.services.receiver.Receiver/";
const STEPS_UPDATE =
  "twirp/github.actions.results.api.v1.WorkflowStepUpdateService/WorkflowStepsUpdate";

/**
 * The steps of a native job with what each check logged. `reports[i]` is step i's outcome; a step
 * with none didn't run. A job that ran no step at all (one we can't run natively) puts `reason`
 * on its first step, so the log still says why the job failed.
 */
export function jobStepLogs(
  steps: { id?: string; name: string }[],
  reports: ({ ok: boolean; lines: string[] } | undefined)[],
  reason?: string,
): StepLog[] {
  const ranNone = reports.every((report) => report === undefined);
  return steps.flatMap((step, index) => {
    if (!step.id) return [];
    const report =
      reports[index] ??
      (ranNone && index === 0 && reason ? { ok: false, lines: [`##[error]${reason}`] } : null);
    return [
      {
        id: step.id,
        number: index + 1,
        name: step.name,
        ok: report ? report.ok : null,
        lines: report?.lines ?? [],
      },
    ];
  });
}

/** Sends the steps and their logs. Throws on the first request GitHub turns down. */
export async function uploadJobLogs(
  target: JobLogTarget,
  steps: StepLog[],
  times: { startedAt: Date; completedAt: Date },
  signal?: AbortSignal,
) {
  const ids = { workflow_run_backend_id: target.planId, workflow_job_run_backend_id: target.jobId };
  const post = async <T>(path: string, body: unknown) => {
    const response = await fetch(new URL(path, withSlash(target.resultsUrl)), {
      method: "POST",
      signal,
      headers: {
        authorization: `Bearer ${target.token}`,
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": userAgent,
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok)
      throw new Error(`${path.split("/").pop()} failed with status ${response.status}`);
    return (text ? JSON.parse(text) : {}) as T;
  };
  // Asks for a signed URL, writes the log there as one block, then records it as uploaded.
  const upload = async (kind: "Step" | "Job", lines: string[], stepId?: string) => {
    const text = logText(lines, times.completedAt);
    const step = stepId ? { step_backend_id: stepId } : {};
    const { logs_url: url, blob_storage_type: storage } = await post<{
      logs_url?: string;
      blob_storage_type?: string;
    }>(`${RECEIVER}Get${kind}LogsSignedBlobURL`, { ...ids, ...step });
    if (!url) throw new Error(`Get${kind}LogsSignedBlobURL returned no URL`);
    const put = await fetch(url, {
      method: "PUT",
      signal,
      headers: {
        "content-type": "text/plain",
        ...(storage === "BLOB_STORAGE_TYPE_AZURE" ? { "x-ms-blob-type": "BlockBlob" } : {}),
      },
      body: text,
    });
    if (!put.ok) throw new Error(`${kind} log upload failed with status ${put.status}`);
    await post(`${RECEIVER}Create${kind}LogsMetadata`, {
      ...ids,
      ...step,
      uploaded_at: new Date().toISOString(),
      line_count: text.split("\n").length - 1,
    });
  };

  await post(STEPS_UPDATE, {
    ...ids,
    change_order: 1,
    steps: steps.map((step) => ({
      external_id: step.id,
      number: step.number,
      name: step.name,
      status: COMPLETED,
      started_at: times.startedAt.toISOString(),
      completed_at: times.completedAt.toISOString(),
      conclusion:
        step.ok === null ? CONCLUSION.skipped : step.ok ? CONCLUSION.success : CONCLUSION.failure,
    })),
  });
  const logged = steps.filter((step) => step.lines.length > 0);
  await Promise.all([
    ...logged.map((step) => upload("Step", step.lines, step.id)),
    upload(
      "Job",
      logged.flatMap((step) => [`##[group]${step.name}`, ...step.lines, "##[endgroup]"]),
    ),
  ]);
}

// Each log line starts with its time, as the runner writes them.
export function logText(lines: string[], at: Date) {
  const stamp = at.toISOString().replace("Z", "0000Z");
  return lines
    .flatMap((line) => line.split(/\r?\n/))
    .map((line) => `${stamp} ${line}\n`)
    .join("");
}

const withSlash = (url: string) => (url.endsWith("/") ? url : `${url}/`);
