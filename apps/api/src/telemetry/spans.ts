// Workflow runs as OpenTelemetry spans, in OTLP/HTTP JSON. A run attempt is one trace: the run is
// its root span, each job a child, and each job holds a "Waiting for a runner" span and its steps.
// Attributes follow the CI/CD semantic conventions (cicd.*, vcs.*), plus relayrunner.* for what
// only RelayRunner knows: where a job ran, how long it waited, and what it used.
//
// Ids are hashes of GitHub's ids, so a job's spans can go out when the job finishes and the run's
// when the run does, and the backend joins them into one trace. A redelivered webhook makes the
// same spans again rather than a second trace.
import type { JobStep, WorkflowJob, WorkflowRun } from "@relayrunner/github-webhooks";
import type { JobUsage } from "@relayrunner/machine-protocol";

export type AttributeValue = string | number | boolean | string[];
export type Attributes = Record<string, AttributeValue | null | undefined>;

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: "server" | "internal";
  // Epoch milliseconds.
  start: number;
  end: number;
  attributes: Attributes;
  // Set when the span failed: its status becomes ERROR with this message.
  error?: string;
}

export interface Repository {
  id: number;
  fullName: string;
}

/** The resource for one repository's spans. service.name is added when they're sent. */
export function repositoryResource(repository: Repository): Attributes {
  return {
    "vcs.repository.name": repository.fullName,
    "vcs.repository.url.full": `https://github.com/${repository.fullName}`,
    "vcs.owner.name": repository.fullName.split("/")[0],
  };
}

async function hashId(text: string, bytes: number) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest, 0, bytes), (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
}

/** A run attempt's trace id, and its root span's id. */
export async function runIds(repositoryId: number, runId: number, runAttempt: number) {
  const key = `${repositoryId}:${runId}:${runAttempt}`;
  return { traceId: await hashId(`trace:${key}`, 16), spanId: await hashId(`run:${key}`, 8) };
}

// GitHub's conclusions as cicd.pipeline.result / cicd.pipeline.task.run.result.
const RESULTS: Record<string, string> = {
  success: "success",
  neutral: "success",
  failure: "failure",
  cancelled: "cancellation",
  skipped: "skip",
  timed_out: "timeout",
};
const FAILED = new Set(["failure", "timeout", "error"]);

function result(conclusion: string | null) {
  const value = conclusion ? (RESULTS[conclusion] ?? "error") : "error";
  // error.type is required on failed spans; GitHub's conclusion is the most specific we have.
  const failed = FAILED.has(value);
  return { value, error: failed ? (conclusion ?? "error") : undefined };
}

const time = (iso: string | null | undefined) => {
  const ms = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(ms) ? null : ms;
};

const runUrl = (repository: Repository, runId: number, attempt: number) =>
  `https://github.com/${repository.fullName}/actions/runs/${runId}/attempts/${attempt}`;

export interface RunDetails {
  repository: Repository;
  run: WorkflowRun;
  // The run's pick, when it had one: the provider it chose and the ones it passed over, with why.
  route: { provider: string | null; skipped: string[] } | null;
  // RelayRunner started this attempt because the last one's runner failed (src/retries.ts).
  retry: boolean;
}

/** The root span of a finished run attempt, or null when GitHub didn't say when it started. */
export async function runSpan({ repository, run, route, retry }: RunDetails): Promise<Span | null> {
  const start = time(run.runStartedAt);
  const end = time(run.updatedAt);
  if (start === null || end === null) return null;
  const ids = await runIds(repository.id, run.id, run.runAttempt);
  const { value, error } = result(run.conclusion);
  return {
    ...ids,
    name: run.workflowName ? `RUN ${run.workflowName}` : "RUN",
    kind: "server",
    start,
    end: Math.max(start, end),
    attributes: {
      "cicd.pipeline.name": run.workflowName,
      "cicd.pipeline.run.id": String(run.id),
      "cicd.pipeline.run.url.full": run.htmlUrl ?? runUrl(repository, run.id, run.runAttempt),
      "cicd.pipeline.result": value,
      "cicd.pipeline.action.name": "RUN",
      "error.type": error,
      "vcs.ref.head.name": run.headBranch,
      "vcs.ref.head.revision": run.headSha,
      "vcs.change.id": run.pullRequestNumber === null ? null : String(run.pullRequestNumber),
      "relayrunner.run.attempt": run.runAttempt,
      "relayrunner.run.event": run.event,
      "relayrunner.run.title": run.displayTitle,
      "relayrunner.run.actor": run.triggeredBy?.login ?? run.actorLogin,
      "relayrunner.routed": route !== null,
      "relayrunner.route.provider": route?.provider,
      "relayrunner.route.skipped": route?.skipped.length ? route.skipped : null,
      "relayrunner.retry": retry,
    },
    error,
  };
}

export interface JobDetails {
  repository: Repository;
  job: WorkflowJob;
  // Where it ran: the provider (machine, github, depot, ...) and the runner's name. Null when no
  // runner took it.
  ranOn: { provider: string; runner: string } | null;
  usage: JobUsage | null;
}

/** A finished job's span, its wait for a runner, and its steps. Empty when GitHub sent no times. */
export async function jobSpans({ repository, job, ranOn, usage }: JobDetails): Promise<Span[]> {
  const queued = time(job.createdAt);
  const started = time(job.startedAt);
  const end = time(job.completedAt);
  if (queued === null || end === null) return [];
  const { traceId, spanId: runSpanId } = await runIds(repository.id, job.runId, job.runAttempt);
  const spanId = await hashId(`job:${job.id}`, 8);
  const { value, error } = result(job.conclusion);
  const ran = started !== null && started >= queued;
  const spans: Span[] = [
    {
      traceId,
      spanId,
      parentSpanId: runSpanId,
      name: job.name,
      kind: "internal",
      start: queued,
      end: Math.max(queued, end),
      attributes: {
        "cicd.pipeline.name": job.workflowName,
        "cicd.pipeline.run.id": String(job.runId),
        "cicd.pipeline.task.name": job.name,
        "cicd.pipeline.task.run.id": String(job.id),
        "cicd.pipeline.task.run.url.full": `https://github.com/${repository.fullName}/actions/runs/${job.runId}/job/${job.id}`,
        "cicd.pipeline.task.run.result": value,
        "cicd.worker.name": job.runnerName,
        "error.type": error,
        "vcs.ref.head.name": job.headBranch,
        "vcs.ref.head.revision": job.headSha,
        "relayrunner.labels": job.labels,
        "relayrunner.provider": ranOn?.provider,
        "relayrunner.runner": ranOn?.runner,
        "relayrunner.queue.wait_ms": ran ? started - queued : null,
        // GitHub rounds each job up to whole minutes.
        "relayrunner.billed_minutes": ran ? Math.max(1, Math.ceil((end - started) / 60_000)) : null,
        "relayrunner.cpu.p95": usage?.cpuP95,
        "relayrunner.memory.p95_mb": usage?.memoryP95Mb,
        "relayrunner.cpus": usage?.cpus,
        "relayrunner.memory_mb": usage?.memoryMb,
      },
      error,
    },
  ];
  if (ran && started > queued)
    spans.push({
      traceId,
      spanId: await hashId(`job:${job.id}:wait`, 8),
      parentSpanId: spanId,
      name: "Waiting for a runner",
      kind: "internal",
      start: queued,
      end: started,
      attributes: { "relayrunner.provider": ranOn?.provider },
    });
  const steps = await Promise.all(
    (job.steps ?? []).map((step) => stepSpan(traceId, spanId, job.id, step)),
  );
  for (const span of steps) if (span) spans.push(span);
  return spans;
}

async function stepSpan(
  traceId: string,
  parentSpanId: string,
  jobId: number,
  step: JobStep,
): Promise<Span | null> {
  const start = time(step.startedAt);
  const end = time(step.completedAt);
  // Skipped steps and ones that never ran have no times worth drawing.
  if (start === null || end === null || step.conclusion === "skipped") return null;
  const { value, error } = result(step.conclusion);
  return {
    traceId,
    spanId: await hashId(`job:${jobId}:step:${step.number}`, 8),
    parentSpanId,
    name: step.name,
    kind: "internal",
    start,
    end: Math.max(start, end),
    attributes: {
      "relayrunner.step.number": step.number,
      "relayrunner.step.result": value,
      "error.type": error,
    },
    error,
  };
}

/** A small trace for the Settings page's test button: a run with one job, ending now. */
export async function testSpans(now = Date.now()): Promise<Span[]> {
  const traceId = await hashId(`test:${now}`, 16);
  const spanId = await hashId(`test-run:${now}`, 8);
  const attributes = { "relayrunner.test": true };
  return [
    {
      traceId,
      spanId,
      name: "RUN RelayRunner test",
      kind: "server",
      start: now - 3_000,
      end: now,
      attributes,
    },
    {
      traceId,
      spanId: await hashId(`test-job:${now}`, 8),
      parentSpanId: spanId,
      name: "Test job",
      kind: "internal",
      start: now - 2_500,
      end: now - 500,
      attributes,
    },
  ];
}

// OTLP/JSON encoding (opentelemetry-proto's JSON mapping): ids as hex, nanosecond times and 64-bit
// ints as strings, enums as numbers.
const KIND = { internal: 1, server: 2 } as const;
const STATUS_ERROR = 2;

function encodeValue(value: AttributeValue): Record<string, unknown> {
  if (Array.isArray(value))
    return { arrayValue: { values: value.map((v) => ({ stringValue: v })) } };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number")
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  return { stringValue: value };
}

function encodeAttributes(attributes: Attributes) {
  return Object.entries(attributes).flatMap(([key, value]) =>
    value === null || value === undefined ? [] : [{ key, value: encodeValue(value) }],
  );
}

const nanos = (ms: number) => `${Math.round(ms)}000000`;

const SCOPE = { name: "relayrunner" };

/** The OTLP export request for some spans, one entry per resource. */
export function otlpRequest(groups: { resource: Attributes; spans: Span[] }[]) {
  return {
    resourceSpans: groups.map(({ resource, spans }) => ({
      resource: { attributes: encodeAttributes(resource) },
      scopeSpans: [
        {
          scope: SCOPE,
          spans: spans.map((span) => ({
            traceId: span.traceId,
            spanId: span.spanId,
            ...(span.parentSpanId && { parentSpanId: span.parentSpanId }),
            name: span.name,
            kind: KIND[span.kind],
            startTimeUnixNano: nanos(span.start),
            endTimeUnixNano: nanos(span.end),
            attributes: encodeAttributes(span.attributes),
            status: span.error ? { code: STATUS_ERROR, message: span.error } : {},
          })),
        },
      ],
    })),
  };
}
