// Evaluations for the dev preview (lib/sample/answers.ts), like GET /api/evaluations/:id. The
// signed-out Evaluate page (routes/evaluate.$provider.tsx) shows sampleEvaluation as its example.
import { BASE_BOOK, isProviderId, labelForSize, listRate } from "@relayrunner/providers";
import {
  type Attempt,
  EVALUATION_RUNS,
  type EvaluationReport,
  type EvaluationState,
  type EvaluationWorkflow,
  type RecentEvaluation,
  type Split,
} from "../evaluations.ts";

const s = (seconds: number) => seconds * 1000;
const split = (wait: number, run: number): Split => ({
  waitMs: s(wait),
  runMs: s(run),
});

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

const SAMPLE_JOBS: [string, Split, Split, Split][] = [
  ["lint", split(9, 62), split(6, 58), split(4, 31)],
  ["typecheck", split(11, 94), split(7, 88), split(4, 52)],
  ["unit tests", split(14, 336), split(8, 301), split(5, 188)],
  ["build", split(12, 188), split(7, 205), split(5, 96)],
  ["e2e smoke", split(41, 251), split(9, 262), split(6, 171)],
];

const SAMPLE_RUN_MS = [475, 310, 298, 304, 301].map(s);

// Billed minutes of each run (each job's run time rounded up): 18 cold, 11 warm.
const SAMPLE_RUN_MINUTES = [18, 11, 11, 11, 11];

// Each run's cost at the provider's list price for its runner, as the API prices them, or $0.012 a
// minute for a provider without one.
function runUsd(provider: string, label: string): number[] {
  const rate = (isProviderId(provider) && listRate(BASE_BOOK, provider, label)) || 0.012;
  return SAMPLE_RUN_MINUTES.map((minutes) => minutes * rate);
}

/** A made-up evaluation: `done` attempts finished, the next one running. */
export function sampleEvaluation(
  provider: string,
  done: number,
  state?: EvaluationState,
  stopped = false,
) {
  const vcpus = 4;
  const label = labelForSize(provider, vcpus, 0) ?? "";
  const runCosts = runUsd(provider, label);
  const attempts: Attempt[] = SAMPLE_RUN_MS.map((ms, i) => {
    const attempt = i + 1;
    const status =
      attempt <= done ? "done" : attempt === done + 1 && !stopped ? "running" : "waiting";
    return {
      attempt,
      status,
      conclusion: status === "done" ? "success" : null,
      ms: status === "done" ? ms : null,
      usd: status === "done" ? runCosts[i]! : null,
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
    label,
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
        ? { ms: SAMPLE_RUN_MS[0]!, waitMs: 7_000, usd: runCosts[0]! }
        : { ms: null, waitMs: null, usd: null },
    warm:
      done >= 2
        ? { ms: 302_000, waitMs: 5_000, usd: runCosts[1]! }
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
