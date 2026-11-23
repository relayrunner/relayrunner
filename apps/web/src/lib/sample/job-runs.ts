// A job's runs and steps for the dev preview (lib/sample/answers.ts), like GET /api/job-times/runs.
import { DAY_MS, type JobRow, type JobRun, type RunStep } from "@/lib/job-times";
import { sampleJobTimes } from "./job-times";
import { seededRandom } from "./shared.ts";

/** The runs of the sample job named, over `days`. */
export function sampleJobRuns(
  days: number,
  repositoryId: number,
  workflow: string | null,
  name: string,
) {
  const job = sampleJobTimes(days)
    .workflows.find((w) => w.repositoryId === repositoryId && w.workflow === workflow)
    ?.jobs.find((j) => j.name === name);
  return { days, runs: job ? sampleRuns(job, days) : [], steps: job ? sampleSteps(job) : [] };
}

function sampleRuns(job: JobRow, days: number): JobRun[] {
  const now = Date.now();
  let id = 0;
  const random = seededRandom(7);
  return Object.entries(job.byEnvironment).flatMap(([environment, stat]) =>
    Array.from({ length: stat.samples }, () => {
      id += 1;
      const completedAt = now - random() * days * DAY_MS;
      const runMs = (stat.medianMs ?? 0) * (0.8 + random() * 0.4);
      return {
        id,
        runId: id,
        runAttempt: 1,
        environment,
        conclusion: random() > 0.95 ? "failure" : "success",
        queuedAt: null,
        startedAt: completedAt - runMs,
        completedAt,
      };
    }),
  );
}

// A typical Node job's steps, scaled to its median.
function sampleSteps(job: JobRow): RunStep[] {
  const medianMs = Object.values(job.byEnvironment)[0]?.medianMs ?? 180_000;
  const steps: [string, RunStep["phase"], number][] = [
    ["Set up job", "setup", 0.03],
    ["Run actions/checkout@v4", "checkout", 0.04],
    ["Run pnpm/action-setup@v4", "setup", 0.02],
    ["Run actions/setup-node@v4", "setup", 0.09],
    ["Run pnpm install --frozen-lockfile", "dependencies", 0.18],
    ["Run pnpm build", "work", 0.22],
    ["Run pnpm test", "work", 0.34],
    ["Post Run actions/setup-node@v4", "cache", 0.07],
    ["Post Run actions/checkout@v4", "cleanup", 0.002],
    ["Complete job", "cleanup", 0.003],
  ];
  return steps.map(([name, phase, share]) => ({ name, phase, ms: Math.round(medianMs * share) }));
}
