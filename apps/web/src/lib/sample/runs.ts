// Runs, jobs and steps for the dev preview (lib/sample/answers.ts), like GET /api/runs and
// /api/runs/jobs.
import { relayInputs } from "@relayrunner/runner-order";
import type { RouteWalk } from "../route-walk";
import type { Environment, TypicalTime } from "../job-times";
import type {
  HistoryJob,
  JobFailure,
  JobStep,
  JobsReport,
  Run,
  RunHeader,
  RunJob,
  RunJobs,
  RunsReport,
} from "../runs.ts";

/** A made-up commit sha for sample data, the same for the same number. */
export const sampleSha = (n: number) =>
  `${((n * 2_654_435_761) >>> 0).toString(16).padStart(8, "0")}${"0".repeat(32)}`;
/** Made-up GitHub accounts for sample data. */
export const sampleActor = (n: number) => (n % 3 === 0 ? "hubot" : "octocat");

/** An example failure for a sample job. */
export function sampleJobFailure(): JobFailure {
  return {
    failedStep: "6. Run pnpm check",
    runnerFailed: false,
    annotations: [],
    log: [
      "##[group]Run pnpm check",
      "pnpm check",
      "##[endgroup]",
      "> relayrunner@ check /home/runner/work/app/app",
      "> pnpm lint && pnpm typecheck",
      "",
      "src/routes/runs.ts(49,7): error TS18047: 'user' is possibly 'null'.",
      " ELIFECYCLE  Command failed with exit code 2.",
      "##[error]Process completed with exit code 2.",
    ],
    cause: { kind: "lint", confidence: 0.92, passesOnRerun: 0.04, rerun: "fails" },
  };
}

const now = Date.now();

const MIN = 60_000;

const SAMPLE_PRS = [
  { branch: "fix-flaky-cache", pullRequest: 214, title: "Fix the flaky cache test" },
  { branch: "main", pullRequest: null, title: "Bump the Node version" },
  { branch: "faster-builds", pullRequest: 211, title: "Build packages in parallel" },
];

/** A made-up branch and pull request for sample run `n`. */
const sampleBranch = (n: number) => SAMPLE_PRS[n % SAMPLE_PRS.length]!;

/** Sample run `n`'s commit, who started it, and its branch and pull request. */
export const sampleRunInfo = (n: number) => ({
  sha: sampleSha(n),
  actor: sampleActor(n),
  ...sampleBranch(n),
});

function sampleRun(run: Partial<Run> & Pick<Run, "runId">): Run {
  return {
    repositoryId: 1,
    repository: "acme/app",
    runAttempt: 1,
    workflow: "CI",
    title: null,
    event: "push",
    actor: sampleActor(run.runId),
    sha: sampleSha(run.runId),
    branch: "main",
    pullRequest: null,
    url: "https://github.com",
    status: "completed",
    conclusion: "success",
    startedAt: now - 12 * MIN,
    updatedAt: now - 9 * MIN,
    wallMs: 161_000,
    environments: ["container", "github:linux-2-core"],
    routed: true,
    usualMs: 170_000,
    supersededBy: null,
    ...run,
  };
}

const SAMPLE_ENVIRONMENTS: Environment[] = [
  { key: "github:linux-2-core", label: "ubuntu-latest", detail: "GitHub-hosted" },
  { key: "container", label: "Cloudflare Container", detail: "standard-1" },
  { key: "machine:sample", label: "Ada's MacBook Pro", detail: "MacBook Pro · Apple M3 Max" },
];

/** Example runs for `VITE_AUTH_DISABLED=true` dev builds, which have no API. */
export function sampleRuns(): RunsReport {
  return {
    days: 14,
    environments: SAMPLE_ENVIRONMENTS,
    runs: [
      sampleRun({
        runId: 6,
        title: "docs: add the runs view design",
        status: "in_progress",
        conclusion: null,
        startedAt: now - 65_000,
        updatedAt: now - 5_000,
        wallMs: null,
      }),
      sampleRun({
        runId: 5,
        title: "feat(api,web): count lint runs in the free check savings",
        event: "pull_request",
        pullRequest: 193,
        branch: "feat/lint-savings",
      }),
      sampleRun({
        runId: 7,
        title: "feat(api,web): count lint runs in the free check savings",
        event: "pull_request",
        pullRequest: 193,
        branch: "feat/lint-savings",
        conclusion: "cancelled",
        startedAt: now - 15 * MIN,
        updatedAt: now - 12 * MIN,
        wallMs: 74_000,
        supersededBy: { runId: 5, runAttempt: 1 },
      }),
      sampleRun({
        runId: 4,
        repository: "acme/ci-tests",
        title: "fix(api): start a new pick runner when a relay job is left without one",
        event: "pull_request",
        pullRequest: 12,
        branch: "feat/fix-picks",
        conclusion: "failure",
        startedAt: now - 25 * MIN,
        updatedAt: now - 21 * MIN,
        wallMs: 231_000,
        usualMs: 120_000,
        environments: ["container", "machine:sample", "github:linux-2-core"],
      }),
      sampleRun({
        runId: 3,
        workflow: "Release",
        title: "chore: release 1.4.0",
        routed: false,
        startedAt: now - 40 * MIN,
        updatedAt: now - 39 * MIN,
        wallMs: 52_000,
        usualMs: 61_000,
        environments: ["github:linux-2-core"],
      }),
      sampleRun({
        runId: 2,
        workflow: "Nightly",
        title: null,
        event: "schedule",
        actor: null,
        conclusion: "timed_out",
        routed: false,
        startedAt: now - 9 * 60 * MIN,
        updatedAt: now - 9 * 60 * MIN + 15 * MIN,
        wallMs: 15 * MIN + 12_000,
        usualMs: null,
        environments: ["github:linux-2-core"],
      }),
    ],
    truncated: false,
  };
}

// A sample run's pick: the machine was busy, so GitHub-hosted took it.
const SAMPLE_WALK: RouteWalk = {
  step: "github",
  skipped: [
    {
      key: "machine",
      reason: "machine_full",
      full: [{ machine: "MacBook Pro", running: 2, slots: 2 }],
    },
  ],
  notInOrder: [],
  ...relayInputs({ machine: ["self-hosted"], github: ["ubuntu-latest"] }),
};

// Usual times for the sample runs' jobs, by name.
const SAMPLE_TYPICAL: Record<string, TypicalTime> = {
  Lint: { medianMs: 22_000, p90Ms: 26_000, samples: 50 },
  Test: { medianMs: 140_000, p90Ms: 170_000, samples: 44 },
  Typecheck: { medianMs: 39_000, p90Ms: 45_000, samples: 31 },
};

/** Example jobs for a sample run: one from sampleRuns, or one the sample job list names. */
export function sampleRunJobs(run: Pick<Run, "runId">): RunJobs {
  const listed = sampleRuns().runs.find((each) => each.runId === run.runId);
  const header: RunHeader = {
    repository: "acme/app",
    workflow: "CI",
    title: null,
    event: "push",
    actor: sampleActor(run.runId),
    sha: sampleSha(run.runId),
    branch: "main",
    pullRequest: null,
    url: "https://github.com",
    status: "completed",
    conclusion: "success",
    ...listed,
  };
  if (!listed) {
    const jobs = sampleJobs(14).jobs.filter((job) => job.runId === run.runId);
    return {
      run: jobs[0]
        ? { ...header, repository: jobs[0].repository, workflow: jobs[0].workflow }
        : null,
      environments: SAMPLE_ENVIRONMENTS,
      jobs: jobs.reverse().map((job) => ({ ...job, status: "completed", typical: null })),
      walk: null,
    };
  }
  const start = listed.startedAt ?? now;
  const job = (
    id: number,
    name: string,
    environment: string,
    waitS: number,
    runS: number,
    conclusion = "success",
  ): RunJob => ({
    id,
    name,
    environment,
    status: "completed",
    conclusion,
    queuedAt: start,
    startedAt: start + waitS * 1000,
    completedAt: start + (waitS + runS) * 1000,
    typical: SAMPLE_TYPICAL[name] ?? null,
  });
  if (run.runId === 6)
    return {
      run: header,
      walk: SAMPLE_WALK,
      environments: SAMPLE_ENVIRONMENTS,
      jobs: [
        job(61, "Lint", "container", 2, 21),
        {
          ...job(62, "Test", "github:linux-2-core", 6, 0),
          status: "in_progress",
          conclusion: null,
          completedAt: null,
        },
        {
          ...job(63, "Typecheck", "machine:sample", 0, 0),
          status: "queued",
          conclusion: null,
          startedAt: null,
          completedAt: null,
        },
      ],
    };
  return {
    run: header,
    walk: null,
    environments: SAMPLE_ENVIRONMENTS,
    jobs: {
      4: [
        job(41, "Lint", "container", 22, 24),
        job(42, "Typecheck", "machine:sample", 190, 41),
        job(43, "Test", "github:linux-2-core", 8, 150, "failure"),
      ],
      2: [job(21, "End-to-end", "github:linux-2-core", 12, 15 * 60, "timed_out")],
      7: [
        job(71, "Lint", "container", 20, 23),
        job(72, "Test", "github:linux-2-core", 7, 47, "cancelled"),
      ],
    }[run.runId] ?? [
      job(51, "Lint", "container", 20, 23),
      job(52, "Test", "github:linux-2-core", 7, 131),
    ],
  };
}

/** Example job list for `VITE_AUTH_DISABLED=true` dev builds. */
export function sampleJobs(days: number): JobsReport {
  const names = ["Lint", "Typecheck", "Test", "Build"];
  const environments = [
    "container",
    "machine:sample",
    "github:linux-2-core",
    "github:linux-2-core",
  ];
  const jobs = Array.from({ length: 36 }, (_, index): HistoryJob => {
    const completedAt = now - index * 37 * MIN;
    const runMs = (20 + ((index * 53) % 170)) * 1000;
    const startedAt = completedAt - runMs;
    const runId = 500 - Math.floor(index / 4);
    return {
      id: 1000 - index,
      runId,
      ...sampleRunInfo(runId),
      runAttempt: 1,
      ...(index % 9 === 4
        ? { repositoryId: 2, repository: "acme/ci-tests" }
        : { repositoryId: 1, repository: "acme/app" }),
      workflow: index % 7 === 3 ? "Release" : "CI",
      name: names[index % 4]!,
      environment: environments[index % 4]!,
      conclusion: index % 11 === 5 ? "failure" : index % 13 === 7 ? "cancelled" : "success",
      queuedAt: startedAt - ((index * 17) % 90) * 1000,
      startedAt,
      completedAt,
      // The Mac's jobs report what they used.
      ...(index % 4 === 1 && {
        usage: {
          cpuP95: 0.25 + ((index * 29) % 70) / 100,
          cpuPeak: Math.min(0.4 + ((index * 29) % 70) / 100, 1),
          memoryP95Mb: 900 + ((index * 337) % 2600),
          memoryPeakMb: 1100 + ((index * 337) % 2600),
          cpus: 4,
          memoryMb: 8192,
          samples: Math.round(runMs / 5000),
        },
      }),
    };
  });
  return { days, environments: SAMPLE_ENVIRONMENTS, jobs, truncated: false };
}

/** Example steps for a sample job, spread over its run time. */
export function sampleJobSteps(job: Pick<RunJob, "startedAt" | "completedAt" | "conclusion">) {
  const names = [
    "Set up job",
    "Run actions/checkout@v6",
    "Run pnpm/action-setup@v6",
    "Run actions/setup-node@v6",
    "Run pnpm install --frozen-lockfile",
    "Run pnpm check",
    "Post Run actions/checkout@v6",
    "Complete job",
  ];
  const shares = [0.04, 0.06, 0.05, 0.1, 0.25, 0.48, 0.01, 0.01];
  const start = job.startedAt ?? now;
  const end = job.completedAt ?? now;
  let at = start;
  return names.map((name, index): JobStep => {
    const from = at;
    at = index === names.length - 1 ? end : from + (end - start) * shares[index]!;
    const failed = job.conclusion === "failure" && name === "Run pnpm check";
    const live = job.completedAt === null && index === names.length - 1;
    return {
      number: index + 1,
      name,
      status: live ? "in_progress" : "completed",
      conclusion: live ? null : failed ? "failure" : "success",
      startedAt: from,
      completedAt: at,
    };
  });
}
