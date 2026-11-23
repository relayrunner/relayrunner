// The dev preview's API (VITE_AUTH_DISABLED): what each GET answers with sample data instead of the
// gateway. lib/api.ts imports this only in that mode, so none of it ships in the real dashboard.
import type { ActivityFilter, ActivityResult } from "@/lib/activity";
import { sampleRoutingHealth, type RoutingRange } from "@/lib/admin-routing";
import { EVALUATION_RUNS, SAMPLE_WORKFLOWS, sampleEvaluation } from "@/lib/evaluations";
import { BASE_CATALOG } from "@relayrunner/providers/catalog";
import { DEFAULT_RETRY_SETTINGS, type FreeMinutesProvider } from "@relayrunner/runner-order";
import { allFlags } from "@/lib/flags";
import { DAY_MS, sampleJobTimes } from "@/lib/job-times";
import { sampleJobTypeTimes } from "@/lib/job-types";
import { sampleLiveJobs } from "@/lib/live-jobs";
import { SAMPLE_MACHINES } from "@/lib/machines";
import type { ProviderHealth } from "@/lib/provider-health";
import { sampleProviderTrends } from "@/lib/provider-trends";
import { type ChartPer, sampleProviderReport, sampleProvidersOverview } from "@/lib/providers";
import { sampleRouteOutcomes } from "@/lib/route-outcomes";
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
import { sampleActivityOptions, sampleActivityPage } from "./activity";
import { sampleJobRuns } from "./job-runs";
import { sampleCheckSavings, sampleUsageReport } from "./usage";
import {
  sampleProviderSpend,
  sampleRouterActionsUsage,
  sampleRouterConnections,
  sampleRouterFreeMinutes,
  sampleRunnerOrder,
} from "./router";
import { sampleAutoJobs, sampleRouterSetup, sampleRunnerGroupCheck } from "./router-setup";
import { sampleParam } from "./param";
import { sampleWorkflowReport } from "./workflow";

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

// The jobs of the last run the sample listed, so a job's steps can follow its times.
const listedJobs = new Map<number, RunJob>();

const ANSWERS: [RegExp, Answer][] = [
  [/^\/usage$/, (_, q) => sampleUsageReport(daysOf(q))],
  [/^\/usage\/checks$/, (_, q) => sampleCheckSavings(daysOf(q))],
  [
    /^\/activity$/,
    (_, q) =>
      sampleActivityPage({
        filter: (q.get("filter") ?? undefined) as ActivityFilter | undefined,
        since: q.has("since") ? Number(q.get("since")) : undefined,
        repository: q.get("repository") ?? undefined,
        result: (q.get("result") ?? undefined) as ActivityResult | undefined,
        machine: q.get("machine") ?? undefined,
      }),
  ],
  [/^\/activity\/options$/, () => sampleActivityOptions()],
  [/^\/usage\/actions$/, () => sampleRouterActionsUsage()],
  [/^\/admin\/routing$/, (_, q) => sampleRoutingHealth(q.get("range") as RoutingRange)],
  [/^\/evaluations\/workflows$/, () => ({ workflows: SAMPLE_WORKFLOWS })],
  [/^\/evaluations$/, () => ({ evaluations: [] })],
  [/^\/evaluations\/([^/]+)$/, ([, id]) => sampleEvaluationById(decodeURIComponent(id!))],
  [/^\/providers\/catalog$/, () => ({ providers: BASE_CATALOG })],
  [/^\/providers\/connections$/, () => sampleRouterConnections()],
  [/^\/providers\/spend$/, () => sampleProviderSpend()],
  [
    /^\/providers\/(blacksmith|groundbox)\/minutes$/,
    ([, provider]) => sampleRouterFreeMinutes(provider as FreeMinutesProvider),
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
  [
    /^\/job-times\/runs$/,
    (_, q) =>
      sampleJobRuns(
        daysOf(q),
        Number(q.get("repositoryId")),
        q.get("workflow"),
        q.get("name") ?? "",
      ),
  ],
  [
    /^\/job-times\/workflow$/,
    (_, q) => sampleWorkflowReport(daysOf(q), Number(q.get("repositoryId")), q.get("workflow")),
  ],
  [/^\/job-times\/machines$/, (_, q) => ({ days: daysOf(q), machines: {} })],
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
  [/^\/runs\/live$/, () => sampleLiveJobs()],
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
      listedJobs.clear();
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
  [/^\/workspaces\/[^/]+\/runner-order$/, () => sampleRunnerOrder()],
  // `?sample=connect` on a provider's Evaluate page: its GitHub App isn't installed yet.
  [
    /^\/workspaces\/[^/]+\/provider-apps$/,
    () => ({ installed: sampleParam() === "connect" ? [] : null }),
  ],
  [/^\/workspaces\/[^/]+\/route-outcomes$/, () => sampleRouteOutcomes()],
  [/^\/workspaces\/[^/]+\/router-setup$/, () => sampleRouterSetup()],
  [/^\/workspaces\/[^/]+\/runner-group-check$/, () => ({ check: sampleRunnerGroupCheck() })],
  [/^\/workspaces\/[^/]+\/auto-jobs$/, () => sampleAutoJobs()],
  [/^\/workspaces\/[^/]+\/retry-settings$/, () => DEFAULT_RETRY_SETTINGS],
  [/^\/workspaces\/[^/]+\/ai$/, () => ({ offAt: null })],
  [/^\/workspaces\/[^/]+\/provider-health$/, () => sampleHealth()],
  // Every flag on, to show what's behind them.
  [/^\/flags$/, () => allFlags(true)],
];

// What a change answers, from the body it sent. Changes not listed go nowhere: the page keeps what
// it shows.
const CHANGES: [RegExp, (body: Record<string, unknown>) => unknown][] = [
  // Planned sizes come back as asked.
  [/\/planned-sizes$/, (body) => ({ planned: body.jobs })],
  // A new evaluation opens the running sample.
  [/^\/evaluations$/, (body) => ({ id: `sample:${body.provider}` })],
];

// An Evaluate page's `?id=sample:<provider>` runs 2 of 5; `sample:<provider>:waiting`, `:starting`,
// `:first` (run 1 going), `:done` and `:stopped-<n>` (stopped after n runs) show the other states.
function sampleEvaluationById(id: string) {
  const [, provider = "blacksmith", state] = id.split(":");
  if (state === "waiting") return sampleEvaluation(provider, 0, "waiting");
  if (state === "done") return sampleEvaluation(provider, EVALUATION_RUNS);
  if (state === "first") return sampleEvaluation(provider, 0);
  if (state?.startsWith("stopped-"))
    return sampleEvaluation(provider, Number(state.slice(8)) || 0, undefined, true);
  if (state === "starting") {
    const report = sampleEvaluation(provider, 0);
    return {
      ...report,
      attempts: report.attempts.map((a) => ({ ...a, status: "waiting" as const, jobs: [] })),
    };
  }
  return sampleEvaluation(provider, 2);
}

// `?sample=unhealthy` on the page shows one runner type the Router skips.
function sampleHealth(): ProviderHealth {
  if (sampleParam() !== "unhealthy") return { enabled: true, unhealthy: [] };
  return {
    enabled: true,
    unhealthy: [
      { key: "depot", label: "depot-ubuntu-24.04", misses: 3, retryAt: Date.now() + 8 * 60_000 },
    ],
  };
}

function filterOf(query: URLSearchParams): SignalFilter {
  return Object.fromEntries(
    FILTER_KEYS.flatMap((key) => (query.has(key) ? [[key, query.get(key)!]] : [])),
  );
}

/** The sample answer to an API call, as the gateway would send it. */
export function sampleAnswer(path: string, init?: RequestInit): unknown {
  const url = new URL(path, "http://sample");
  if (init?.method && init.method !== "GET") {
    const change = CHANGES.find(([pattern]) => pattern.test(url.pathname));
    return change ? change[1](init.body ? JSON.parse(String(init.body)) : {}) : {};
  }
  for (const [pattern, answer] of ANSWERS) {
    const match = url.pathname.match(pattern);
    if (match) return structuredClone(answer(match, url.searchParams));
  }
  throw new Error(`The dev preview has no sample for GET ${url.pathname}`);
}
