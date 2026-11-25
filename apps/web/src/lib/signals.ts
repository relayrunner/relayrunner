import { CircleDollarSignIcon, GaugeIcon, LayersIcon, type LucideIcon } from "lucide-react";
import { DOCS_URL } from "@/components/site-footer";
import { api } from "@/lib/api";
import { triggerText } from "@/lib/runs";
import { reportQuery, type TimeRange } from "@/lib/time-range";
export type SignalArea = "speed" | "cost" | "complexity";
export type SignalId =
  | "no-concurrency"
  | "same-commit"
  | "short-jobs"
  | "queue-waits"
  | "slowest-job"
  | "flaky-jobs"
  | "runner-failures"
  | "docs-changes"
  | "wide-fanout";

/** One repo and workflow (or workflow › job) a signal affects. Money is USD. */
export type SignalRow = {
  repository: string;
  subject: string;
  workflowPath: string | null;
  /** On Waiting for a runner rows, the runner the jobs went to, for its panel. */
  runnerKey: string | null;
  count: number;
  minutes: number;
  cost: number;
};

export type Signal = {
  id: SignalId;
  area: SignalArea;
  count: number;
  minutes: number;
  cost: number;
  rows: SignalRow[];
};

export type BreakdownBy = "person" | "repository" | "workflow" | "branch" | "trigger" | "path";

/** One login, repo, workflow, branch, trigger or folder and the jobs it ran. Money is USD. */
export type BreakdownRow = {
  /** A trigger is an event name, or "rerun"; a folder is ROOT_FOLDER for files at the root. */
  name: string;
  /** The workflow's or folder's repository, on workflow and path rows. */
  repository: string | null;
  workflowPath: string | null;
  runs: number;
  minutes: number;
  cost: number;
};

export type Breakdown = {
  /** The most time first. */
  rows: BreakdownRow[];
  /** Everything else, summed. */
  other: { runs: number; minutes: number; cost: number } | null;
};

/** A filter's job minutes per UTC day, oldest first, and the same days of the range before. */
export type SignalTrend = { minutes: number[]; previous: number[] | null };

/** GET /api/signals: the signals over the threshold, the most time first, and the Breakdown. */
export type SignalsReport = {
  days: number;
  totals: { jobs: number; minutes: number; cost: number };
  signals: Signal[];
  breakdown: Record<BreakdownBy, Breakdown>;
  /** On a filtered page; null when the filter is on more than one view. */
  trend?: SignalTrend | null;
};

/**
 * What the page narrows to, as the URL and the API name it: Breakdown values, a workflow or folder
 * with its repo. A trigger is an event name, or "rerun".
 */
export const FILTER_KEYS = ["person", "repo", "workflow", "branch", "trigger", "path"] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];
export type SignalFilter = Partial<Record<FilterKey, string>>;

/** A filtered page works its numbers out from single jobs, which go back this many days. */
export const FILTERED_MAX_DAYS = 30;

export const isFiltered = (filter: SignalFilter) => FILTER_KEYS.some((key) => filter[key]);

/** The filter a Breakdown row narrows the page to. */
export function rowFilter(by: BreakdownBy, row: BreakdownRow): SignalFilter {
  if (by === "workflow" || by === "path")
    return { repo: row.repository ?? undefined, [by]: row.name };
  return { [by === "repository" ? "repo" : by]: row.name };
}

/** One run attempt behind a signal row (GET /api/signals/runs). Times are epoch ms. */
export type SignalRun = {
  repositoryId: number;
  repository: string;
  runId: number;
  runAttempt: number;
  /** The job the signal is about, on job signals. */
  jobId: number | null;
  workflow: string | null;
  title: string | null;
  event: string | null;
  branch: string | null;
  sha: string | null;
  actor: string | null;
  conclusion: string | null;
  startedAt: number | null;
  /** The part of the run the signal counts. */
  runMs: number;
  cost: number;
};

export type SignalRunsReport = {
  days: number;
  runs: SignalRun[];
  total: number;
  /** The row's minutes per day over `days`, oldest first and ending today, when known. */
  perDay?: number[];
};

/** A signal row, as the runs panel names it. */
export type SignalRowRef = { signal: SignalId; repository: string; subject: string };

/** The Breakdown's views, in the order the page offers them. */
export const BREAKDOWN_VIEWS: { value: BreakdownBy; label: string }[] = [
  { value: "person", label: "Person" },
  { value: "repository", label: "Repository" },
  { value: "workflow", label: "Workflow" },
  { value: "branch", label: "Branch" },
  { value: "trigger", label: "Trigger" },
  { value: "path", label: "Changed folder" },
];

/** The folder pull request files at the root of a repo go under. */
export const ROOT_FOLDER = "/";

/** A folder the way the page names it. */
export const folderName = (folder: string) => (folder === ROOT_FOLDER ? "Root files" : folder);

/** A trigger the way people say it: "Push", "Pull request", "Manual", "Re-run". */
export function triggerName(event: string) {
  const text = event === "rerun" ? "re-run" : (triggerText({ event, pullRequest: null }) ?? event);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function query(range: TimeRange, filter: SignalFilter, extra: Record<string, string> = {}) {
  const filters = FILTER_KEYS.flatMap((key) => (filter[key] ? [[key, filter[key]]] : []));
  return reportQuery(range, { ...extra, ...Object.fromEntries(filters) });
}

export function getSignals(range: TimeRange, filter: SignalFilter = {}) {
  return api<SignalsReport>(`/signals?${query(range, filter)}`);
}

export function getSignalRuns(row: SignalRowRef, range: TimeRange, filter: SignalFilter) {
  const extra = { signal: row.signal, in: row.repository, subject: row.subject };
  return api<SignalRunsReport>(`/signals/runs?${query(range, filter, extra)}`);
}

export const AREAS: Record<SignalArea, { title: string; question: string; icon: LucideIcon }> = {
  speed: { title: "Speed", question: "Why is CI slow?", icon: GaugeIcon },
  cost: { title: "Cost", question: "Why does CI cost this much?", icon: CircleDollarSignIcon },
  complexity: {
    title: "Complexity",
    question: "Is CI doing more than it needs to?",
    icon: LayersIcon,
  },
};

type Link = { label: string; href: string };

/**
 * Each signal's area, fixed title, what it means, its table's column names and where to go next,
 * in the order the page lists signals that didn't show up.
 */
export const SIGNAL_COPY: Record<
  SignalId,
  {
    area: SignalArea;
    title: string;
    about: string;
    subject: string;
    count: string;
    minutes: string;
    /** False when the signal costs time but no money, so its spend column stays empty. */
    spend?: false;
    action?: Link;
    docs?: string;
  }
> = {
  "no-concurrency": {
    area: "cost",
    title: "No concurrency limit",
    about:
      "These runs kept going after someone pushed again to the same branch. A concurrency group with cancel-in-progress stops the older run when a newer one starts. Minutes count from when the newer run started. Your default branch is left out.",
    subject: "Workflow",
    count: "Runs superseded",
    minutes: "Minutes",
    docs: "https://docs.github.com/en/actions/using-jobs/using-concurrency",
  },
  "same-commit": {
    area: "cost",
    title: "Same commit runs twice",
    about:
      "These workflows ran for the same commit from both push and pull_request. Limiting push to your default branch keeps the pull request run. Minutes and spend are the push runs.",
    subject: "Workflow",
    count: "Commits",
    minutes: "Minutes",
    docs: "https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions#onpushbranchestagsbranches-ignoretags-ignore",
  },
  "short-jobs": {
    area: "cost",
    title: "Short jobs rounded up",
    about:
      "GitHub bills each job by the whole minute. These jobs finished in under a minute on a billed runner, so you paid for time they didn't use. Minutes and spend are the unused part.",
    subject: "Job",
    count: "Jobs under 1m",
    minutes: "Unused minutes",
    action: { label: "Set up optimized checks", href: `${DOCS_URL}/concepts/optimized-checks` },
  },
  "queue-waits": {
    area: "speed",
    title: "Waiting for a runner",
    about:
      "These jobs waited more than a minute after GitHub queued them before a runner took them. That happens when every runner with these labels is busy, or when the account hits its limit on jobs running at once. Adding a step to your runner order sends them somewhere free instead.",
    subject: "Runner",
    count: "Jobs waited",
    minutes: "Minutes waited",
    spend: false,
    action: { label: "Edit the runner order", href: "/router" },
    docs: "https://docs.github.com/en/actions/reference/limits",
  },
  "slowest-job": {
    area: "speed",
    title: "One job sets the pace",
    about:
      "This job ran alongside the others in its run and was still going after they all finished, so the run waited on it alone. Minutes are that wait. Splitting the job or giving it a faster runner shortens every run.",
    subject: "Job",
    count: "Finished last",
    minutes: "Minutes alone",
    spend: false,
    action: { label: "Compare runners", href: "/performance" },
  },
  "flaky-jobs": {
    area: "speed",
    title: "Flaky jobs",
    about:
      "These jobs failed in one of their steps and then passed when the run was tried again, so the failure likely wasn't the change. Minutes and spend are the failed attempts.",
    subject: "Job",
    count: "Passed on re-run",
    minutes: "Failed minutes",
  },
  "runner-failures": {
    area: "speed",
    title: "Runner failures",
    about:
      "These jobs failed before any of their steps started, so the runner was the problem, not your code. Automatic retries can send them to another runner.",
    subject: "Runner",
    count: "Jobs failed",
    minutes: "Failed minutes",
    action: { label: "Set up retries", href: "/router" },
  },
  "docs-changes": {
    area: "complexity",
    title: "Docs changes run CI",
    about:
      "These workflows ran for pull requests that only changed docs, or for commits titled as docs changes, such as docs: fix a typo. Path filters let a workflow skip changes that only touch docs.",
    subject: "Workflow",
    count: "Docs runs",
    minutes: "Minutes",
    docs: "https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions#onpushpull_requestpull_request_targetpathspaths-ignore",
  },
  "wide-fanout": {
    area: "complexity",
    title: "Full matrix on every branch",
    about:
      "These workflows started 10 or more jobs for a push or pull request on a branch other than your default. A smaller matrix before merge, with the full one on your default branch, still catches most problems.",
    subject: "Workflow",
    count: "Runs with 10+ jobs",
    minutes: "Minutes",
    docs: "https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/running-variations-of-jobs-in-a-workflow",
  },
};
