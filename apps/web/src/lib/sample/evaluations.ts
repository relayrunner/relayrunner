// Evaluations for the dev preview (lib/sample/answers.ts), like GET /api/evaluations/:id.
import { labelForSize } from "@relayrunner/providers";
import {
  type Attempt,
  EVALUATION_RUNS,
  type EvaluationReport,
  type EvaluationState,
  type EvaluationWorkflow,
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
    baseline: { runs: 20, medianMs: 520_000, waitMs: 12_000, usd: 0.114 },
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
