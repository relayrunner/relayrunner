// The dev preview's API (VITE_AUTH_DISABLED): what each GET answers with sample data instead of the
// gateway. lib/api.ts imports this only in that mode, so none of it ships in the real dashboard.
import { sampleActionsUsage } from "@/lib/actions-usage";
import { sampleRoutingHealth, type RoutingRange } from "@/lib/admin-routing";
import { SAMPLE_WORKFLOWS } from "@/lib/evaluations";
import type { FreeMinutesProvider } from "@relayrunner/runner-order";
import { sampleFreeMinutes } from "@/lib/free-minutes";
import { sampleJobTimes } from "@/lib/job-times";
import { sampleJobTypeTimes } from "@/lib/job-types";
import { SAMPLE_MACHINES } from "@/lib/machines";
import { sampleConnections } from "@/lib/provider-connections";
import { sampleProviderTrends } from "@/lib/provider-trends";
import { type ChartPer, sampleProviderReport, sampleProvidersOverview } from "@/lib/providers";
import { sampleRouteOutcomes } from "@/lib/route-outcomes";
import { sampleAutoJobs, sampleRouterSetup, sampleRunnerGroupCheck } from "@/lib/router-sample";
import { sampleRunnerReport } from "@/lib/runner-report";
import {
  type RunJob,
  sampleJobFailure,
  sampleJobs,
  sampleJobSteps,
  sampleRunJobs,
  sampleRuns,
} from "@/lib/runs";
import {
  FILTER_KEYS,
  type SignalFilter,
  type SignalId,
  sampleSignalRuns,
  sampleSignals,
} from "@/lib/signals";
import { sampleLogBucket, sampleTelemetry } from "@/lib/telemetry";

const DAY_MS = 86_400_000;

type Answer = (match: RegExpMatchArray, query: URLSearchParams) => unknown;

// The window a report query asks for: `days` back from now, or `from` to `to`.
function windowOf(query: URLSearchParams, now = Date.now()) {
  const days = Number(query.get("days"));
  if (days > 0) return { from: now - days * DAY_MS, to: now };
  return { from: Number(query.get("from")), to: Number(query.get("to")) || now };
}

const daysOf = (query: URLSearchParams) => {
  const { from, to } = windowOf(query);
  return Math.max(1, Math.round((to - from) / DAY_MS));
};

// Jobs the sample runs listed, so a job's steps can follow its times.
const listedJobs = new Map<number, RunJob>();

const ANSWERS: [RegExp, Answer][] = [
  [/^\/usage\/actions$/, () => sampleActionsUsage()],
  [/^\/admin\/routing$/, (_, q) => sampleRoutingHealth(q.get("range") as RoutingRange)],
  [/^\/evaluations\/workflows$/, () => ({ workflows: SAMPLE_WORKFLOWS })],
  [/^\/evaluations$/, () => ({ evaluations: [] })],
  [/^\/providers\/catalog$/, () => ({ providers: [] })],
  [/^\/providers\/connections$/, () => sampleConnections()],
  [
    /^\/providers\/(blacksmith|groundbox)\/minutes$/,
    ([, provider]) => sampleFreeMinutes(provider as FreeMinutesProvider, false),
  ],
  [
    /^\/providers\/([^/]+)\/trends$/,
    ([, provider], q) => {
      const days = daysOf(q);
      return sampleProviderTrends(sampleProviderReport(provider!, days).runners, days);
    },
  ],
  [/^\/providers\/([^/]+)$/, ([, provider], q) => sampleProviderReport(provider!, daysOf(q))],
  [
    /^\/providers$/,
    (_, q) => sampleProvidersOverview(daysOf(q), { per: (q.get("per") ?? "day") as ChartPer }),
  ],
  [/^\/job-times$/, (_, q) => sampleJobTimes(daysOf(q))],
  [/^\/job-times\/types$/, (_, q) => sampleJobTypeTimes(daysOf(q))],
  [/^\/job-times\/runner$/, (_, q) => sampleRunnerReport(q.get("key") ?? "", windowOf(q))],
  [/^\/machines$/, () => ({ machines: SAMPLE_MACHINES, others: [] })],
  [/^\/machines\/mine$/, () => ({ machines: SAMPLE_MACHINES })],
  [
    /^\/runs$/,
    (_, q) => {
      // The sample is the last few days: keep the runs the window holds, as the API would.
      const { from, to } = windowOf(q);
      const repo = q.get("repo");
      const workflow = q.get("workflow");
      const sample = sampleRuns();
      const runs = sample.runs.filter(
        (run) =>
          run.updatedAt >= from &&
          run.updatedAt < to &&
          (!repo || (run.repository === repo && run.workflow === workflow)),
      );
      return { ...sample, runs };
    },
  ],
  [/^\/runs\/jobs$/, (_, q) => sampleJobs(daysOf(q))],
  [/^\/runs\/jobs\/\d+\/failure$/, () => sampleJobFailure()],
  [
    /^\/runs\/jobs\/(\d+)\/steps$/,
    ([, id]) => {
      const job = listedJobs.get(Number(id));
      return { steps: job ? sampleJobSteps(job) : null };
    },
  ],
  [
    /^\/runs\/\d+\/(\d+)\/\d+\/jobs$/,
    ([, runId]) => {
      const answer = sampleRunJobs({ runId: Number(runId) });
      for (const job of answer.jobs) listedJobs.set(job.id, job);
      return answer;
    },
  ],
  [/^\/signals$/, (_, q) => sampleSignals(daysOf(q), filterOf(q))],
  [
    /^\/signals\/runs$/,
    (_, q) =>
      sampleSignalRuns(
        {
          signal: q.get("signal") as SignalId,
          repository: q.get("in") ?? "",
          subject: q.get("subject") ?? "",
        },
        daysOf(q),
      ),
  ],
  [/^\/telemetry$/, () => sampleTelemetry()],
  [/^\/log-bucket$/, () => sampleLogBucket()],
  [/^\/workspaces\/[^/]+\/route-outcomes$/, () => sampleRouteOutcomes()],
  [/^\/workspaces\/[^/]+\/router-setup$/, () => sampleRouterSetup()],
  [/^\/workspaces\/[^/]+\/runner-group-check$/, () => ({ check: sampleRunnerGroupCheck() })],
  [/^\/workspaces\/[^/]+\/auto-jobs$/, () => sampleAutoJobs()],
];

function filterOf(query: URLSearchParams): SignalFilter {
  return Object.fromEntries(
    FILTER_KEYS.flatMap((key) => (query.has(key) ? [[key, query.get(key)!]] : [])),
  );
}

/** The sample answer to an API call, as the gateway would send it. */
export function sampleAnswer(path: string, init?: RequestInit): unknown {
  const url = new URL(path, "http://sample");
  // Changes go nowhere: the preview keeps what the page shows.
  if (init?.method && init.method !== "GET") return {};
  for (const [pattern, answer] of ANSWERS) {
    const match = url.pathname.match(pattern);
    if (match) return structuredClone(answer(match, url.searchParams));
  }
  throw new Error(`The dev preview has no sample for GET ${url.pathname}`);
}
