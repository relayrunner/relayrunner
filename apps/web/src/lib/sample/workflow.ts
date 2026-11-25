// Made-up workflow reports for the dev preview (lib/sample/answers.ts): CI in acme/app on GitHub,
// a laptop, Blacksmith (from an evaluation and routed runs) and a container.
import type { WorkflowReport, WorkflowRunner, WorkflowRunPoint } from "@relayrunner/api-types";
import { DAY_MS } from "@/lib/job-times";
import { seededRandom } from "./shared.ts";

const LINUX = "github:linux-2-core";
const MAC = "machine:sample";
const BLACKSMITH = "blacksmith:blacksmith-4vcpu-ubuntu-2404";
const CONTAINER = "container";

// Each runner's usual seconds per job, its price per minute and its usual seconds
// waiting for a runner.
const JOBS = ["test", "typecheck", "lint", "build"] as const;
const PLAN: Record<
  string,
  { seconds: number[]; rate: number; wait: number; skip?: (typeof JOBS)[number] }
> = {
  [LINUX]: { seconds: [190, 92, 41, 125], rate: 0.006, wait: 9 },
  [MAC]: { seconds: [81, 38, 12, 52], rate: 0, wait: 2 },
  [BLACKSMITH]: { seconds: [104, 55, 22, 70], rate: 0.008, wait: 4 },
  // Containers aren't sent the build.
  [CONTAINER]: { seconds: [168, 84, 24, 0], rate: 0.0028, wait: 14, skip: "build" },
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

export function sampleWorkflowReport(
  days: number,
  repositoryId: number,
  workflow: string | null,
  now = Date.now(),
): WorkflowReport {
  const next = seededRandom(7);
  // A standard normal draw, for log-normal job times with a long right tail.
  const gauss = () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
  let runs: WorkflowRunPoint[] = [];
  let runId = 9000;
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const run = (env: string, at: number, { evaluation = false, cold = false } = {}) => {
    if (at > now) return;
    const plan = PLAN[env]!;
    const hour = new Date(at).getHours();
    const daysAgo = (now - at) / DAY_MS;
    // The test suite grows a little each day, and a cache fix 12 days ago cut every job by a tenth.
    const drift = (1 - daysAgo * 0.002) * (daysAgo > 12 ? 1.1 : 1);
    // A cache miss now and then, and a flaky test that needs a rerun.
    const miss = cold || next() < 0.06 ? 1.35 + next() * 0.4 : 1;
    const attempt = next() < 0.04 ? 2 : 1;
    // GitHub-hosted runners queue longer at the busiest hours.
    const busy = env === LINUX && hour >= 10 && hour <= 16 ? 2.2 : 1;
    const jobs = JOBS.filter((name) => name !== plan.skip).map((name) => {
      const noise = Math.exp(gauss() * 0.09) * (next() < 0.015 ? 1.8 + next() : 1);
      const ms = Math.round(plan.seconds[JOBS.indexOf(name)]! * 1000 * noise * drift * miss);
      const waitMs = Math.round(plan.wait * 1000 * busy * Math.exp(gauss() * 0.6));
      return { name, environment: env, ms, waitMs, usd: billed(ms) * plan.rate };
    });
    // A container run sends its build to GitHub, so the run is mixed.
    if (plan.skip) {
      const ms = Math.round(125_000 * Math.exp(gauss() * 0.09) * drift);
      const waitMs = Math.round(9000 * busy * Math.exp(gauss() * 0.6));
      jobs.push({ name: plan.skip, environment: LINUX, ms, waitMs, usd: billed(ms) * 0.006 });
    }
    const slowest = Math.max(...jobs.map((job) => job.ms + (job.waitMs ?? 0)));
    runs.push({
      runId: (runId += 1),
      runAttempt: attempt,
      at,
      ms: slowest + 4000 + Math.round(next() * 6000),
      usd: jobs.reduce((sum, job) => sum + job.usd, 0),
      environment: plan.skip ? null : env,
      evaluation,
      jobs,
    });
  };
  // Which runner takes a push: Blacksmith only took routed runs in the last six days, and the
  // laptop only takes runs while someone is at it.
  const pick = (daysAgo: number, hour: number, weekend: boolean) => {
    const atDesk = !weekend && hour >= 9 && hour < 19;
    const weights = [
      [LINUX, daysAgo < 6 ? 0.4 : 0.6],
      [MAC, atDesk ? 0.25 : 0],
      [BLACKSMITH, daysAgo < 6 ? 0.3 : 0],
      [CONTAINER, 0.15],
    ] as const;
    let roll = next() * weights.reduce((sum, [, weight]) => sum + weight, 0);
    for (const [env, weight] of weights) if ((roll -= weight) < 0) return env;
    return LINUX;
  };
  for (let day = days - 1; day >= 0; day--) {
    const start = midnight.getTime() - day * DAY_MS;
    const weekend = [0, 6].includes(new Date(start).getDay());
    // A nightly scheduled run on GitHub at 03:00.
    run(LINUX, start + 3 * 3_600_000 + next() * 300_000);
    // Pushes cluster in working hours, around late morning and mid afternoon, in small bursts.
    const pushes = Math.round((weekend ? 4 : 34) * (0.7 + next() * 0.6));
    for (let i = 0; i < pushes; i++) {
      const center = next() < 0.5 ? 11 : 15;
      const hour = Math.min(23.5, Math.max(6, center + gauss() * 2.2));
      const at = start + hour * 3_600_000;
      const burst = next() < 0.2 ? 2 + Math.floor(next() * 3) : 1;
      for (let b = 0; b < burst; b++)
        run(pick(day, Math.floor(hour), weekend), at + b * (2 + next() * 8) * 60_000);
    }
  }
  // An evaluation on Blacksmith before it took routed runs: five back to back, the first cold.
  const evaluatedAt = midnight.getTime() - Math.min(days - 1, 9) * DAY_MS + 14 * 3_600_000;
  for (let i = 0; i < 5; i++)
    run(BLACKSMITH, evaluatedAt + i * 4 * 60_000, { evaluation: true, cold: i === 0 });
  runs.sort((a, b) => a.at - b.at);
  // The API reads the newest JOB_LIMIT jobs in the window (reports/workflow-compare.ts).
  let budget = 5000;
  let truncated = false;
  runs = runs
    .toReversed()
    .filter((point) => {
      budget -= point.jobs.length;
      if (budget < 0) truncated = true;
      return budget >= 0;
    })
    .toReversed();

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
    truncated,
  };
}
