// Made-up workflow reports for the dev preview (lib/sample/answers.ts): CI in acme/app on GitHub,
// a laptop, Blacksmith (from an evaluation and routed runs) and a container.
import type { WorkflowReport, WorkflowRunner, WorkflowRunPoint } from "@relayrunner/api-types";
import { DAY_MS } from "@/lib/job-times";
import { sampleParam } from "./param.ts";
import { seededRandom } from "./shared.ts";

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

function median(values: number[]) {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const billed = (ms: number) => Math.max(1, Math.ceil(ms / 60_000));

/** A row per runner: its runs, evaluations, and median run and jobs over `runs`. */
function summarize(envs: (typeof ENVIRONMENTS)[string][], runs: WorkflowRunPoint[]) {
  return envs.map((env): WorkflowRunner => {
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
}

export function sampleWorkflowReport(
  days: number,
  repositoryId: number,
  workflow: string | null,
  now = Date.now(),
): WorkflowReport {
  if (sampleParam() === "ph") return phWorkflowReport(days, repositoryId, workflow, now);
  const next = seededRandom(7);
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

  const runners = summarize(Object.values(ENVIRONMENTS), runs);

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

// `?sample=ph`: CI on a mix of runners, each with its own history over the range: a laptop of the
// team's own, GitHub's, and three providers at speeds they typically show against GitHub's 2-vCPU
// runner (Blacksmith about 1.9x, Boat about 1.5x, Ubicloud about 1.3x). GitHub's runs slowed for a
// few days; Blacksmith and Boat started taking runs after an evaluation.
const BOAT = "boat:boat";
const UBICLOUD = "ubicloud:ubicloud-standard-4";

type PhPlan = {
  info: (typeof ENVIRONMENTS)[string];
  /** Usual seconds per job, in JOBS order. */
  seconds: number[];
  rate: number;
  /** Runs a day, roughly. */
  perDay: number;
  wait: number;
  /** How much each run varies, as a share of its time. */
  spread: number;
  /** The oldest day (days ago) it took routed runs, if not the whole range. */
  since?: number;
  /** A share of days it didn't run (a laptop asleep). */
  idle?: number;
  /** Its speed on a day, days ago: 1 is usual. */
  speed?: (daysAgo: number) => number;
  /** Its share of runs on a day, days ago, as the Router moved runs between runners: 1 is usual. */
  volume?: (daysAgo: number) => number;
};

const PH_PLAN: Record<string, PhPlan> = {
  [LINUX]: {
    info: ENVIRONMENTS[LINUX]!,
    seconds: [190, 92, 41, 125],
    rate: 0.006,
    perDay: 1.1,
    // Most runs until Blacksmith and Boat took over, then only overflow.
    volume: (d) => (d >= 11 ? 3.2 : d >= 9 ? 1.4 : 0.35),
    wait: 11,
    spread: 0.16,
    speed: (d) => (d <= 9 && d >= 6 ? 1.22 : 1),
  },
  [MAC]: {
    info: ENVIRONMENTS[MAC]!,
    seconds: [84, 40, 13, 54],
    rate: 0,
    perDay: 2.6,
    wait: 2,
    spread: 0.3,
    idle: 0.15,
  },
  [BLACKSMITH]: {
    info: { ...ENVIRONMENTS[BLACKSMITH]!, label: "blacksmith-4vcpu-ubuntu-2404" },
    seconds: [100, 50, 20, 66],
    rate: 0.008,
    perDay: 2.2,
    volume: (d) => (d >= 7 ? 1.3 : 0.8),
    wait: 4,
    spread: 0.1,
    since: 11,
  },
  [BOAT]: {
    info: { key: BOAT, label: "boat", detail: "Boat", size: { vcpus: 4, memoryGb: 8 } },
    seconds: [128, 62, 26, 84],
    rate: 0.0006,
    perDay: 2,
    volume: (d) => (d >= 7 ? 0.6 : 1.4),
    wait: 3,
    spread: 0.12,
    since: 9,
  },
  [UBICLOUD]: {
    info: {
      key: UBICLOUD,
      label: "ubicloud-standard-4",
      detail: "Ubicloud",
      size: { vcpus: 4, memoryGb: 16 },
    },
    seconds: [150, 74, 31, 100],
    rate: 0.0016,
    perDay: 0.8,
    // Tried for a few days, then dropped down the order.
    volume: (d) => (d >= 8 && d <= 12 ? 2.2 : 0.15),
    wait: 14,
    spread: 0.2,
  },
};

const PH_DENSITY = 12;

function phWorkflowReport(
  days: number,
  repositoryId: number,
  workflow: string | null,
  now: number,
): WorkflowReport {
  const next = seededRandom(11);
  const runs: WorkflowRunPoint[] = [];
  let runId = 9000;
  // A slow day-to-day drift per runner, so lines wander a little.
  const drift = new Map(Object.keys(PH_PLAN).map((key) => [key, 1]));
  const run = (
    env: string,
    at: number,
    daysAgo: number,
    { evaluation = false, cold = false } = {},
  ) => {
    const plan = PH_PLAN[env]!;
    const factor = (plan.speed?.(daysAgo) ?? 1) * drift.get(env)! * (cold ? 1.5 : 1);
    // Runs vary around the usual time, with a few slow outliers (a cold cache, a busy host).
    const runNoise =
      1 + (next() - 0.5) * plan.spread * 3 + (next() < 0.08 ? 0.25 + next() * 0.45 : 0);
    const jobs = JOBS.map((name) => {
      const noise = runNoise * (1 + (next() - 0.5) * 0.08);
      const ms = Math.round(plan.seconds[JOBS.indexOf(name)]! * 1000 * noise * factor);
      const waitMs = Math.round(plan.wait * 1000 * (0.4 + next() * 1.2));
      return { name, environment: env, ms, waitMs, usd: billed(ms) * plan.rate };
    });
    runs.push({
      runId: (runId += 1),
      runAttempt: 1,
      at,
      ms: Math.max(...jobs.map((job) => job.ms)) + 6000 + Math.round(next() * 8000),
      usd: jobs.reduce((sum, job) => sum + job.usd, 0),
      environment: env,
      evaluation,
      jobs,
    });
  };
  for (let day = days - 1; day >= 0; day--) {
    const start = now - (day + 1) * DAY_MS;
    for (const [env, plan] of Object.entries(PH_PLAN)) {
      drift.set(env, Math.min(1.1, Math.max(0.9, drift.get(env)! + (next() - 0.5) * 0.06)));
      if (plan.since !== undefined && day > plan.since) continue;
      if (plan.idle && next() < plan.idle) continue;
      // Busy repos run CI dozens of times a day, so the chart reads as a cloud of runs.
      const count = Math.round(
        plan.perDay * (plan.volume?.(day) ?? 1) * PH_DENSITY * (0.5 + next()),
      );
      for (let i = 0; i < count; i++) run(env, start + (0.1 + next() * 0.8) * DAY_MS, day);
    }
  }
  // Evaluations before Blacksmith and Boat took routed runs: five back to back, the first cold.
  for (const [env, daysAgo] of [
    [BLACKSMITH, 12],
    [BOAT, 10],
  ] as const) {
    const at = now - Math.min(days - 1, daysAgo) * DAY_MS;
    for (let i = 0; i < 5; i++)
      run(env, at + i * 4 * 60_000, daysAgo, { evaluation: true, cold: i === 0 });
  }
  runs.sort((a, b) => a.at - b.at);

  const runners = summarize(
    Object.values(PH_PLAN).map((plan) => plan.info),
    runs,
  );
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
    untried: ["depot", "namespace", "warpbuild", "runs-on", "berrybox", "lizard", "groundbox"],
    truncated: false,
  };
}
