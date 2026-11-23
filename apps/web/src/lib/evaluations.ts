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
  /** null while the run history is still being read: GitHub listed the workflow, no run named it yet. */
  relayed: boolean | null;
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
  /** Runs of this workflow on the provider since the evaluation, evaluations left out. */
  routedRuns: number;
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

/** A provider's evaluation from the last RECENT_DAYS days, with its headline numbers. */
export interface RecentEvaluation {
  id: string;
  state: EvaluationState;
  provider: string;
  repositoryId: number;
  repository: string;
  workflow: string | null;
  workflowPath: string;
  vcpus: number;
  attempt: number;
  runs: number;
  createdAt: number;
  /** Runs that finished, and their median time and cost (warm runs, else the cold one). */
  finished: number;
  ms: number | null;
  usd: number | null;
  /** The workflow's recent runs the evaluation compares against. */
  baselineMs: number | null;
  baselineUsd: number | null;
  /** Runs of this workflow on the provider since, evaluations left out. */
  routedRuns: number;
}

/** How long an evaluation stays listed: after this, Performance tells the story. */
export const RECENT_DAYS = 30;
const DAY = 86_400_000;

/** Sample evaluations for the dev preview: one running, one done, and one stopped and since adopted. */
export function sampleEvaluations(provider: string): RecentEvaluation[] {
  const now = Date.now();
  const base = {
    provider,
    repository: "acme/web",
    repositoryId: 1,
    workflowPath: ".github/workflows/ci.yml",
    workflow: "CI",
    vcpus: 4,
    runs: EVALUATION_RUNS,
    baselineMs: 520_000,
    baselineUsd: 0.224,
    routedRuns: 0,
  };
  return [
    {
      ...base,
      id: `sample:${provider}`,
      state: "running",
      attempt: 3,
      finished: 2,
      ms: 318_000,
      usd: 0.131,
      createdAt: now - 25 * 60_000,
    },
    {
      ...base,
      id: `sample:${provider}:done`,
      state: "done",
      attempt: 5,
      finished: 5,
      workflow: "E2E",
      workflowPath: ".github/workflows/e2e.yml",
      baselineMs: 845_000,
      baselineUsd: 0.41,
      ms: 702_000,
      usd: 0.468,
      createdAt: now - 3 * DAY,
    },
    {
      ...base,
      id: `sample:${provider}:stopped-3`,
      state: "cancelled",
      attempt: 4,
      finished: 3,
      repository: "acme/api",
      repositoryId: 2,
      workflow: "Test",
      workflowPath: ".github/workflows/test.yml",
      baselineMs: 390_000,
      baselineUsd: 0.17,
      ms: 236_000,
      usd: 0.098,
      routedRuns: 46,
      createdAt: now - 12 * DAY,
    },
  ];
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

/** The new installation's run history import (apps/api/src/run-history.ts); null when it had none. */
export type RunHistory = { state: "queued" | "running" | "done" | "failed"; runs: number } | null;

export const getRunHistory = () =>
  api<{ history: RunHistory }>("/evaluations/history").then((r) => r.history);

export const listEvaluations = (provider: string) =>
  api<{ evaluations: EvaluationSummary[] }>(
    `/evaluations?provider=${encodeURIComponent(provider)}`,
  ).then((r) => r.evaluations);

export const getRecentEvaluations = (provider: string) =>
  api<{ evaluations: RecentEvaluation[] }>(
    `/evaluations/recent?provider=${encodeURIComponent(provider)}`,
  ).then((r) => r.evaluations);

export const getEvaluation = (id: string) =>
  api<EvaluationReport>(`/evaluations/${encodeURIComponent(id)}`);

export const startEvaluation = (body: {
  repositoryId: number;
  workflowPath: string;
  /** Its name, for a workflow no run named yet. */
  workflowName?: string;
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

// ---- Sample data, for the dev server without sign-in (VITE_AUTH_DISABLED) ------------------------

export const SAMPLE_WORKFLOWS: EvaluationWorkflow[] = [
  {
    repositoryId: 1,
    repository: "acme/web",
    workflow: "CI",
    path: ".github/workflows/ci.yml",
    runs: 214,
    baselineRuns: 61,
    medianMs: 520_000,
    relayed: true,
    dispatched: true,
  },
  {
    repositoryId: 1,
    repository: "acme/web",
    workflow: "E2E",
    path: ".github/workflows/e2e.yml",
    runs: 96,
    baselineRuns: 30,
    medianMs: 845_000,
    relayed: false,
    dispatched: false,
  },
  {
    repositoryId: 2,
    repository: "acme/api",
    workflow: "Test",
    path: ".github/workflows/test.yml",
    runs: 140,
    baselineRuns: 48,
    medianMs: 312_000,
    relayed: true,
    dispatched: false,
  },
];

/** The same workflows while a new installation's history is read: GitHub lists them, no runs yet. */
export const SAMPLE_HISTORY_WORKFLOWS: EvaluationWorkflow[] = SAMPLE_WORKFLOWS.map((w, i) =>
  i === 0
    ? { ...w, runs: 38, baselineRuns: 12, medianMs: 534_000 }
    : { ...w, runs: 0, baselineRuns: 0, medianMs: null, relayed: null },
);

const s = (seconds: number) => seconds * 1000;
const split = (wait: number, run: number): Split => ({
  waitMs: s(wait),
  runMs: s(run),
});
const SAMPLE_JOBS: [string, Split, Split, Split][] = [
  ["lint", split(9, 62), split(6, 58), split(4, 31)],
  ["typecheck", split(11, 94), split(7, 88), split(4, 52)],
  ["unit tests", split(14, 336), split(8, 301), split(5, 188)],
  ["build", split(12, 188), split(7, 205), split(5, 96)],
  ["e2e smoke", split(41, 251), split(9, 262), split(6, 171)],
];
const SAMPLE_RUN_MS = [475, 310, 298, 304, 301].map(s);
// List-price cost of each run: 18 billed minutes cold, 11 warm, at 4 vCPU.
const SAMPLE_RUN_USD = [0.216, 0.132, 0.132, 0.132, 0.132];

/** A made-up evaluation: `done` attempts finished, the next one running. */
export function sampleEvaluation(
  provider: string,
  done: number,
  state?: EvaluationState,
  stopped = false,
) {
  const vcpus = 4;
  const attempts: Attempt[] = SAMPLE_RUN_MS.map((ms, i) => {
    const attempt = i + 1;
    const status =
      attempt <= done ? "done" : attempt === done + 1 && !stopped ? "running" : "waiting";
    return {
      attempt,
      status,
      conclusion: status === "done" ? "success" : null,
      ms: status === "done" ? ms : null,
      usd: status === "done" ? SAMPLE_RUN_USD[i]! : null,
      jobs:
        status === "waiting"
          ? []
          : SAMPLE_JOBS.map(([name, , cold, warm], j) => ({
              name,
              status: status === "done" || j < 2 ? "done" : j === 2 ? "running" : "queued",
              conclusion: status === "done" || j < 2 ? "success" : null,
              split: status === "done" || j < 2 ? (attempt === 1 ? cold : warm) : null,
              onProvider: true,
            })),
    };
  });
  const finished = done >= EVALUATION_RUNS || stopped;
  return {
    id: "sample",
    state: state ?? (stopped ? "cancelled" : finished ? "done" : "running"),
    error: state === "waiting" ? "no_dispatch" : null,
    provider,
    vcpus,
    label: labelForSize(provider, vcpus, 0) ?? "",
    repositoryId: 1,
    repository: "acme/web",
    workflow: "CI",
    workflowPath: ".github/workflows/ci.yml",
    ref: "main",
    runs: EVALUATION_RUNS,
    runId: state === "waiting" ? null : 4421,
    createdAt: Date.now() - 40 * 60_000,
    routedRuns: 0,
    finishedAt: finished ? Date.now() - 4 * 60_000 : null,
    attempts:
      state === "waiting"
        ? attempts.map((a) => ({
            ...a,
            status: "waiting",
            jobs: [],
            ms: null,
            usd: null,
            conclusion: null,
          }))
        : attempts,
    // Today on 4 vCPU GitHub-hosted runners: 14 billed minutes at $0.016, so the sample reads as a saving.
    baseline: { runs: 20, medianMs: 520_000, waitMs: 12_000, usd: 0.224 },
    cold:
      done >= 1
        ? { ms: SAMPLE_RUN_MS[0]!, waitMs: 7_000, usd: SAMPLE_RUN_USD[0]! }
        : { ms: null, waitMs: null, usd: null },
    warm:
      done >= 2
        ? { ms: 302_000, waitMs: 5_000, usd: 0.132 }
        : { ms: null, waitMs: null, usd: null },
    jobs: SAMPLE_JOBS.map(([name, baseline, cold, warm]) => ({
      name,
      baseline,
      cold: done >= 1 ? cold : null,
      warm: done >= 2 ? warm : null,
      onProvider: true,
    })),
  } satisfies EvaluationReport;
}
