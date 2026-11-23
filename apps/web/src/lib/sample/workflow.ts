// Made-up workflow reports for the dev preview (lib/sample/answers.ts): CI in acme/app on GitHub,
// a laptop, Blacksmith (from an evaluation and routed runs) and a container.
import type { WorkflowReport, WorkflowRunner, WorkflowRunPoint } from "@relayrunner/api-types";
import { DAY_MS } from "@/lib/job-times";

const LINUX = "github:linux-2-core";
const MAC = "machine:sample";
const BLACKSMITH = "blacksmith:blacksmith-4vcpu-ubuntu-2404";
const CONTAINER = "container";

// Each runner's usual seconds per job, its price per minute, how often it took a run, and its
// usual seconds waiting for a runner.
const JOBS = ["test", "typecheck", "lint", "build"] as const;
const PLAN: Record<
  string,
  { seconds: number[]; rate: number; share: number; wait: number; skip?: (typeof JOBS)[number] }
> = {
  [LINUX]: { seconds: [190, 92, 41, 125], rate: 0.006, share: 1.6, wait: 9 },
  [MAC]: { seconds: [81, 38, 12, 52], rate: 0, share: 1.1, wait: 2 },
  [BLACKSMITH]: { seconds: [104, 55, 22, 70], rate: 0.008, share: 0.5, wait: 4 },
  // Containers aren't sent the build.
  [CONTAINER]: { seconds: [168, 84, 24, 0], rate: 0.0028, share: 0.8, wait: 14, skip: "build" },
};

const ENVIRONMENTS: Record<
  string,
  Omit<WorkflowRunner, "runs" | "evaluations" | "wholeRuns" | "medianMs" | "usd" | "jobs">
> = {
  [LINUX]: {
    key: LINUX,
    label: "ubuntu-latest",
    detail: "GitHub-hosted",
    size: { vcpus: 2, memoryGb: 8 },
  },
  [MAC]: {
    key: MAC,
    label: "Ada's MacBook Pro",
    detail: "MacBook Pro · Apple M3 Max",
    machine: { source: "connect", kind: "laptop", model: "MacBook Pro" },
  },
  [BLACKSMITH]: {
    key: BLACKSMITH,
    label: "blacksmith-4vcpu-ubuntu-2404",
    detail: "Blacksmith",
    size: { vcpus: 4, memoryGb: 16 },
  },
  [CONTAINER]: {
    key: CONTAINER,
    label: "Cloudflare Container",
    detail: "standard-1",
    size: { vcpus: 0.5, memoryGb: 4 },
  },
};

function random(seed: number) {
  let x = seed;
  return () => {
    x = (x * 1664525 + 1013904223) % 4294967296;
    return x / 4294967296;
  };
}

function median(values: number[]) {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const billed = (ms: number) => Math.max(1, Math.ceil(ms / 60_000));

export function sampleWorkflowReport(
  days: number,
  repositoryId: number,
  workflow: string | null,
  now = Date.now(),
): WorkflowReport {
  const next = random(7);
  const runs: WorkflowRunPoint[] = [];
  let runId = 9000;
  const run = (env: string, at: number, { evaluation = false, cold = false } = {}) => {
    const plan = PLAN[env]!;
    const jobs = JOBS.filter((name) => name !== plan.skip).map((name) => {
      const noise = 1 + (next() - 0.5) * 0.2 + (next() < 0.05 ? 0.4 : 0);
      const ms = Math.round(plan.seconds[JOBS.indexOf(name)]! * 1000 * noise * (cold ? 1.5 : 1));
      const waitMs = Math.round(plan.wait * 1000 * (0.5 + next()));
      return { name, environment: env, ms, waitMs, usd: billed(ms) * plan.rate };
    });
    // A container run sends its build to GitHub, so the run is mixed.
    if (plan.skip) {
      const ms = Math.round(125_000 * (1 + (next() - 0.5) * 0.2));
      const waitMs = Math.round(9000 * (0.5 + next()));
      jobs.push({ name: plan.skip, environment: LINUX, ms, waitMs, usd: billed(ms) * 0.006 });
    }
    const ms = Math.max(...jobs.map((job) => job.ms)) + 6000 + Math.round(next() * 8000);
    runs.push({
      runId: (runId += 1),
      runAttempt: 1,
      at,
      ms,
      usd: jobs.reduce((sum, job) => sum + job.usd, 0),
      environment: plan.skip ? null : env,
      evaluation,
      jobs,
    });
  };
  for (let day = days - 1; day >= 0; day--) {
    const start = now - (day + 1) * DAY_MS;
    for (const env of [LINUX, MAC, BLACKSMITH, CONTAINER]) {
      // Blacksmith only took routed runs in the last few days; the laptop sleeps some days.
      if (env === BLACKSMITH && day > 5) continue;
      if (env === MAC && next() < 0.25) continue;
      const count = Math.round(PLAN[env]!.share * (0.5 + next()));
      for (let i = 0; i < count; i++) run(env, start + (0.1 + next() * 0.8) * DAY_MS);
    }
  }
  // An evaluation on Blacksmith before it took routed runs: five back to back, the first cold.
  const evaluatedAt = now - Math.min(days - 1, 9) * DAY_MS;
  for (let i = 0; i < 5; i++)
    run(BLACKSMITH, evaluatedAt + i * 4 * 60_000, { evaluation: true, cold: i === 0 });
  runs.sort((a, b) => a.at - b.at);

  const runners = Object.values(ENVIRONMENTS).map((env): WorkflowRunner => {
    const touched = runs.filter((point) => point.jobs.some((job) => job.environment === env.key));
    const whole = runs.filter((point) => point.environment === env.key);
    const jobs: WorkflowRunner["jobs"] = {};
    for (const name of JOBS) {
      const list = runs.flatMap((point) =>
        point.jobs.filter((job) => job.name === name && job.environment === env.key),
      );
      if (list.length)
        jobs[name] = {
          runs: list.length,
          medianMs: median(list.map((job) => job.ms)),
          usd: median(list.flatMap((job) => job.usd ?? [])),
        };
    }
    return {
      ...env,
      runs: touched.filter((point) => !point.evaluation).length,
      evaluations: touched.filter((point) => point.evaluation).length,
      wholeRuns: whole.length,
      medianMs: median(whole.map((point) => point.ms)),
      usd: median(whole.flatMap((point) => point.usd ?? [])),
      jobs,
    };
  });

  return {
    repositoryId,
    repository: "acme/app",
    workflow,
    days,
    fewRuns: 5,
    baseline: LINUX,
    jobs: [...JOBS],
    runners: runners
      .filter((runner) => runner.runs + runner.evaluations > 0)
      .sort((a, b) => b.runs + b.evaluations - (a.runs + a.evaluations)),
    runs,
    untried: ["depot", "namespace", "boat", "ubicloud", "berrybox", "lizard", "groundbox"],
    truncated: false,
  };
}
