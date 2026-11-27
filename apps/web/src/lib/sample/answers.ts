// The dev preview's API (VITE_AUTH_DISABLED): what each GET answers with sample data instead of the
// gateway. lib/api.ts imports this only in that mode, so none of it ships in the real dashboard.
import { HOSTED_PROVIDER_IDS } from "@relayrunner/providers";
import type { ActivityFilter, ActivityResult } from "@/lib/activity";
import type { RoutingRange } from "@/lib/admin-routing";
import { EVALUATION_RUNS } from "@/lib/evaluations";
import { BASE_CATALOG } from "@relayrunner/providers/catalog";
import { DEFAULT_RETRY_SETTINGS, type FreeMinutesProvider } from "@relayrunner/runner-order";
import { allFlags } from "@/lib/flags";
import { DAY_MS } from "@/lib/job-times";
import type { ProviderHealth } from "@/lib/provider-health";
import type { ChartPer } from "@/lib/providers";
import type { RunJob } from "@/lib/runs";
import { FILTER_KEYS, type SignalFilter, type SignalId } from "@/lib/signals";
import { sampleActionsUsage } from "./actions-usage";
import { sampleRoutingHealth } from "./admin-routing";
import {
  SAMPLE_HISTORY_WORKFLOWS,
  SAMPLE_WORKFLOWS,
  sampleEvaluation,
  sampleEvaluations,
  sampleFailedEvaluation,
} from "./evaluations";
import { sampleJobTimes } from "./job-times";
import { sampleJobTypeTimes } from "./job-types";
import { sampleLiveJobs } from "./live-jobs";
import { SAMPLE_MACHINES } from "./machines";
import { sampleProviderTrends } from "./provider-trends";
import { sampleProviderReport, sampleProvidersOverview } from "./providers";
import { sampleRouteOutcomes } from "./route-outcomes";
import { sampleRunnerReport } from "./runner-report";
import { sampleJobFailure, sampleJobs, sampleJobSteps, sampleRunJobs, sampleRuns } from "./runs";
import { sampleSignalRuns, sampleSignals } from "./signals";
import { sampleLogBucket, sampleTelemetry } from "./telemetry";
import { sampleActivityOptions, sampleActivityPage } from "./activity";
import { sampleJobRuns } from "./job-runs";
import { samplePullRequests } from "./pull-requests";
import { sampleCheckSavings, sampleUsageReport } from "./usage";
import {
  sampleProviderSpend,
  sampleRouterConnections,
  sampleRouterFreeMinutes,
  sampleRunnerOrder,
} from "./router";
import { sampleAutoJobs, sampleRouterSetup, sampleRunnerGroupCheck } from "./router-setup";
import { sampleParam } from "./param";
import { sampleRepoChecks } from "./repo-checks";
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

// The dev switcher's enterprise. The id has no enterprise, so GitHub serves a generated avatar.
const ACME_ENTERPRISE = {
  slug: "acme",
  avatar: "https://avatars.githubusercontent.com/b/999999999?v=4",
};

const ANSWERS: [RegExp, Answer][] = [
  [/^\/usage$/, (_, q) => sampleUsageReport(daysOf(q))],
  [/^\/usage\/checks$/, (_, q) => sampleCheckSavings(daysOf(q))],
  [/^\/usage\/pull-requests$/, (_, q) => samplePullRequests(windowOf(q))],
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
  [/^\/usage\/actions$/, () => sampleActionsUsage()],
  // The dev switcher's orgs (components/workspace-menu.tsx), two of them in one enterprise.
  [
    /^\/workspaces\/enterprises$/,
    () => ({
      workspaces: [
        { id: "dev", enterprise: null },
        { id: "dev-org", enterprise: ACME_ENTERPRISE },
        { id: "dev-org-2", enterprise: ACME_ENTERPRISE },
      ],
    }),
  ],
  [/^\/admin\/routing$/, (_, q) => sampleRoutingHealth(q.get("range") as RoutingRange)],
  // `?sample=history`: a new installation whose run history is still being read.
  [
    /^\/evaluations\/workflows$/,
    () => ({
      workflows: sampleParam() === "history" ? SAMPLE_HISTORY_WORKFLOWS : SAMPLE_WORKFLOWS,
    }),
  ],
  [
    /^\/evaluations\/history$/,
    () => ({ history: sampleParam() === "history" ? { state: "running", runs: 142 } : null }),
  ],
  [/^\/evaluations$/, () => ({ evaluations: [] })],
  // `?sample=none` on a provider page: no recent evaluations.
  [
    /^\/evaluations\/recent$/,
    (_, q) => ({
      evaluations:
        sampleParam() === "none" ? [] : sampleEvaluations(q.get("provider") ?? "blacksmith"),
    }),
  ],
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
  [/^\/runs\/jobs\/(\d+)\/failure$/, ([, id]) => sampleJobFailure(Number(id))],
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
  // On a provider's Evaluate page, `?sample=connect`: its GitHub App isn't installed yet;
  // `?sample=personal`: a personal account, where GitHub can't tell, so the person confirms it.
  [
    /^\/workspaces\/[^/]+\/provider-apps$/,
    () => ({
      installed:
        sampleParam() === "connect"
          ? []
          : sampleParam() === "personal"
            ? null
            : [...HOSTED_PROVIDER_IDS],
    }),
  ],
  [/^\/workspaces\/[^/]+\/route-outcomes$/, () => sampleRouteOutcomes()],
  [/^\/workspaces\/[^/]+\/router-setup$/, () => sampleRouterSetup()],
  [/^\/workspaces\/[^/]+\/public-repos$/, () => ({ repositories: ["acme/docs"] })],
  [/^\/workspaces\/[^/]+\/repo-checks$/, () => sampleRepoChecks()],
  [/^\/workspaces\/[^/]+\/runner-group-check$/, () => ({ check: sampleRunnerGroupCheck() })],
  [/^\/workspaces\/[^/]+\/auto-jobs$/, () => sampleAutoJobs()],
  [/^\/workspaces\/[^/]+\/retry-settings$/, () => DEFAULT_RETRY_SETTINGS],
  [/^\/workspaces\/[^/]+\/ai$/, () => ({ offAt: null })],
  [/^\/workspaces\/[^/]+\/provider-health$/, () => sampleHealth()],
  // Every flag on, to show what's behind them.
  [/^\/flags$/, () => allFlags(true)],
  // `localStorage["rr-status-preview"] = "degraded"` (or downtime, maintenance) previews the banner.
  [/^\/status$/, () => sampleServiceStatus()],
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
  if (state === "old")
    return {
      ...sampleEvaluation(provider, EVALUATION_RUNS),
      createdAt: Date.now() - 41 * 86_400_000,
      routedRuns: sampleParam() === "unused" ? 0 : 128,
    };
  if (state === "first") return sampleEvaluation(provider, 0);
  // `:mixed` has a job without a relay, which keeps its own runner.
  if (state === "mixed") {
    const report = sampleEvaluation(provider, EVALUATION_RUNS);
    const own = (job: { name: string }) => job.name === "e2e smoke";
    return {
      ...report,
      attempts: report.attempts.map((a) => ({
        ...a,
        jobs: a.jobs.map((job) => (own(job) ? { ...job, onProvider: false } : job)),
      })),
      jobs: report.jobs.map((job) => (own(job) ? { ...job, onProvider: false } : job)),
    };
  }
  // `:failed-<n>` fails after n passing runs; `:refused-<n>` has the provider refuse the job.
  if (state?.startsWith("failed-") || state?.startsWith("refused-"))
    return sampleFailedEvaluation(
      provider,
      Number(state.split("-")[1]) || 0,
      state.startsWith("refused-"),
    );
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

const SAMPLE_INCIDENTS: Record<string, string> = {
  degraded: "Delayed job routing",
  downtime: "Jobs are not being routed",
  maintenance: "Database maintenance until 10:30 AM",
};

function sampleServiceStatus() {
  const state = localStorage.getItem("rr-status-preview");
  if (!state || !(state in SAMPLE_INCIDENTS)) return { state: "operational", incident: null };
  return { state, incident: SAMPLE_INCIDENTS[state] };
}
