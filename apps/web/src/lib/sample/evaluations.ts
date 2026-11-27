// Evaluations for the dev preview (lib/sample/answers.ts), like GET /api/evaluations/:id. The
// signed-out Evaluate page (routes/evaluate.$provider.tsx) shows sampleEvaluation as its example.
import { labelForSize } from "@relayrunner/providers";
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

// List prices per minute: GitHub's 4 vCPU runner today, and the provider's 4 vCPU size.
const TODAY_RATE = 0.016;
const SAMPLE_RATE = 0.012;
/** A job's cost: its running minutes, rounded up, at `rate`. */
const jobUsd = (split: Split | null, rate: number) =>
  split ? Math.ceil(split.runMs / 60_000) * rate : null;

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
              id: 9000 + attempt * 10 + j,
              failedStep: null,
              name,
              status: status === "done" || j < 2 ? "done" : j === 2 ? "running" : "queued",
              conclusion: status === "done" || j < 2 ? "success" : null,
              split: status === "done" || j < 2 ? (attempt === 1 ? cold : warm) : null,
              usd:
                status === "done" || j < 2
                  ? jobUsd(attempt === 1 ? cold : warm, SAMPLE_RATE)
                  : null,
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
      usd: {
        baseline: jobUsd(baseline, TODAY_RATE),
        cold: done >= 1 ? jobUsd(cold, SAMPLE_RATE) : null,
        warm: done >= 2 ? jobUsd(warm, SAMPLE_RATE) : null,
      },
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

/** The sample failed job's id; one more is the provider refusing it in its own setup. */
export const SAMPLE_FAILED_JOB = 9900;

/**
 * A made-up failed evaluation: `passed` runs passed, then the next one's "unit tests" failed. With
 * `refused`, the provider failed it in its own setup before any step ran, as Boat does without a
 * paid plan.
 */
export function sampleFailedEvaluation(provider: string, passed: number, refused: boolean) {
  const report = sampleEvaluation(provider, passed, "failed", true);
  const failed = passed + 1;
  const attempts: Attempt[] = report.attempts.map((a) =>
    a.attempt !== failed
      ? a
      : {
          ...a,
          status: "done",
          conclusion: "failure",
          ms: s(refused ? 21 : 168),
          usd: null,
          jobs: SAMPLE_JOBS.map(([name, , cold, warm], j) => {
            const bad = name === "unit tests";
            const jobSplit = bad
              ? split(refused ? 9 : 8, refused ? 6 : 142)
              : failed === 1
                ? cold
                : warm;
            return {
              id: bad ? SAMPLE_FAILED_JOB + (refused ? 1 : 0) : 9100 + j,
              name,
              status: "done",
              conclusion: bad ? "failure" : "success",
              failedStep: bad ? (refused ? "2. Set up runner" : "6. Run pnpm check") : null,
              split: jobSplit,
              usd: jobUsd(jobSplit, SAMPLE_RATE),
              onProvider: true,
            };
          }),
        },
  );
  const step = refused ? "Set up runner" : "Run pnpm check";
  return {
    ...report,
    error: `Run ${failed} failed: unit tests failed at ${step}.`,
    attempts,
  } satisfies EvaluationReport;
}
