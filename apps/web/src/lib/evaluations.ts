// Provider evaluations (apps/api/src/reports/evaluations.ts): a workflow run five times on a provider,
// compared with its recent runs. These mirror the API's shapes.
import { AUTO_SIZES, labelForSize } from "@relayrunner/providers";
import { api } from "@/lib/api";
export const EVALUATION_RUNS = 5;

export type EvaluationState =
  | "dispatching"
  | "waiting"
  | "running"
  | "done"
  | "failed"
  | "cancelled";

export interface EvaluationWorkflow {
  repositoryId: number;
  repository: string;
  workflow: string | null;
  path: string;
  runs: number;
  baselineRuns: number;
  medianMs: number | null;
  relayed: boolean;
  dispatched: boolean;
}

export interface Split {
  waitMs: number;
  runMs: number;
}

export interface AttemptJob {
  name: string;
  status: "queued" | "running" | "done";
  conclusion: string | null;
  split: Split | null;
  onProvider: boolean;
}

export interface Attempt {
  attempt: number;
  status: "waiting" | "running" | "done";
  conclusion: string | null;
  ms: number | null;
  /** The run's cost at list prices, once done; null when a job ran without a price. */
  usd: number | null;
  jobs: AttemptJob[];
}

export interface JobComparison {
  name: string;
  baseline: Split | null;
  cold: Split | null;
  warm: Split | null;
  onProvider: boolean;
}

export interface EvaluationReport {
  id: string;
  state: EvaluationState;
  error: string | null;
  provider: string;
  vcpus: number;
  label: string;
  repositoryId: number;
  repository: string;
  workflow: string | null;
  workflowPath: string;
  ref: string;
  runs: number;
  runId: number | null;
  createdAt: number;
  finishedAt: number | null;
  attempts: Attempt[];
  baseline: {
    runs: number;
    medianMs: number | null;
    waitMs: number | null;
    usd: number | null;
  };
  cold: { ms: number | null; waitMs: number | null; usd: number | null };
  warm: { ms: number | null; waitMs: number | null; usd: number | null };
  jobs: JobComparison[];
}

export interface EvaluationSummary {
  id: string;
  state: EvaluationState;
  provider: string;
  repository: string;
  workflow: string | null;
  workflowPath: string;
  attempt: number;
  runs: number;
  createdAt: number;
}

export const ACTIVE_STATES: EvaluationState[] = ["dispatching", "waiting", "running"];

/** The sizes a provider offers for an evaluation, with the label each gets. */
export function evaluationSizes(provider: string) {
  return AUTO_SIZES.flatMap((vcpus) => {
    const label = labelForSize(provider, vcpus, 0);
    return label ? [{ vcpus, label }] : [];
  }).filter((size, i, all) => all.findIndex((other) => other.label === size.label) === i);
}

export const getEvaluationWorkflows = () =>
  api<{ workflows: EvaluationWorkflow[] }>("/evaluations/workflows").then((r) => r.workflows);

export const listEvaluations = (provider: string) =>
  api<{ evaluations: EvaluationSummary[] }>(
    `/evaluations?provider=${encodeURIComponent(provider)}`,
  ).then((r) => r.evaluations);

export const getEvaluation = (id: string) =>
  api<EvaluationReport>(`/evaluations/${encodeURIComponent(id)}`);

export const startEvaluation = (body: {
  repositoryId: number;
  workflowPath: string;
  provider: string;
  vcpus: number;
}) =>
  api<{ id: string }>("/evaluations", {
    method: "POST",
    body: JSON.stringify(body),
  });

export const retryEvaluation = (id: string) =>
  api<{ ok: true }>(`/evaluations/${encodeURIComponent(id)}/retry`, {
    method: "POST",
  });

export const cancelEvaluation = (id: string) =>
  api<{ ok: true }>(`/evaluations/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
  });

/** Where to edit a workflow file on GitHub. */
export const editUrl = (repository: string, ref: string, path: string) =>
  `https://github.com/${repository}/edit/${encodeURIComponent(ref)}/${path}`;

export const runUrl = (report: Pick<EvaluationReport, "repository" | "runId">, attempt?: number) =>
  report.runId
    ? `https://github.com/${report.repository}/actions/runs/${report.runId}${attempt ? `/attempts/${attempt}` : ""}`
    : null;
