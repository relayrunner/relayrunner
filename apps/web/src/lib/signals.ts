import { CircleDollarSignIcon, GaugeIcon, LayersIcon, type LucideIcon } from "lucide-react";
import { DOCS_URL } from "@/components/site-footer";
import { api } from "@/lib/api";
import { triggerText } from "@/lib/runs";

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

export type BreakdownBy = "person" | "repository" | "workflow" | "branch" | "trigger";

/** One login, repo, workflow, branch or trigger and the jobs it ran. Money is USD. */
export type BreakdownRow = {
  /** A trigger is an event name, or "rerun". */
  name: string;
  /** The workflow's repository, on workflow rows. */
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

/** GET /api/signals: the signals over the threshold, the most time first, and the Breakdown. */
export type SignalsReport = {
  days: number;
  totals: { jobs: number; minutes: number; cost: number };
  signals: Signal[];
  breakdown: Record<BreakdownBy, Breakdown>;
};

/** The Breakdown's views, in the order the page offers them. */
export const BREAKDOWN_VIEWS: { value: BreakdownBy; label: string }[] = [
  { value: "person", label: "Person" },
  { value: "repository", label: "Repository" },
  { value: "workflow", label: "Workflow" },
  { value: "branch", label: "Branch" },
  { value: "trigger", label: "Trigger" },
];

/** A trigger the way people say it: "Push", "Pull request", "Manual", "Re-run". */
export function triggerName(event: string) {
  const text = event === "rerun" ? "re-run" : (triggerText({ event, pullRequest: null }) ?? event);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function getSignals(days = 30) {
  return api<SignalsReport>(`/signals?days=${days}`);
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

/** Each signal's fixed title, what it means, its table's column names and where to go next. */
export const SIGNAL_COPY: Record<
  SignalId,
  {
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
    title: "No concurrency limit",
    about:
      "These runs kept going after someone pushed again to the same branch. A concurrency group with cancel-in-progress stops the older run when a newer one starts. Minutes count from when the newer run started. Your default branch is left out.",
    subject: "Workflow",
    count: "Runs superseded",
    minutes: "Minutes",
    docs: "https://docs.github.com/en/actions/using-jobs/using-concurrency",
  },
  "same-commit": {
    title: "Same commit runs twice",
    about:
      "These workflows ran for the same commit from both push and pull_request. Limiting push to your default branch keeps the pull request run. Minutes and spend are the push runs.",
    subject: "Workflow",
    count: "Commits",
    minutes: "Minutes",
    docs: "https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions#onpushbranchestagsbranches-ignoretags-ignore",
  },
  "short-jobs": {
    title: "Short jobs rounded up",
    about:
      "GitHub bills each job by the whole minute. These jobs finished in under a minute on a billed runner, so you paid for time they didn't use. Minutes and spend are the unused part.",
    subject: "Job",
    count: "Jobs under 1m",
    minutes: "Unused minutes",
    action: { label: "Set up optimized checks", href: `${DOCS_URL}/concepts/optimized-checks` },
  },
  "queue-waits": {
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
    title: "One job sets the pace",
    about:
      "This job ran alongside the others in its run and was still going after they all finished, so the run waited on it alone. Minutes are that wait. Splitting the job or giving it a faster runner shortens every run.",
    subject: "Job",
    count: "Finished last",
    minutes: "Minutes alone",
    spend: false,
    action: { label: "Compare runners", href: "/performance?view=jobs" },
  },
  "flaky-jobs": {
    title: "Flaky jobs",
    about:
      "These jobs failed in one of their steps and then passed when the run was tried again, so the failure likely wasn't the change. Minutes and spend are the failed attempts.",
    subject: "Job",
    count: "Passed on re-run",
    minutes: "Failed minutes",
  },
  "runner-failures": {
    title: "Runner failures",
    about:
      "These jobs failed before any of their steps started, so the runner was the problem, not your code. Automatic retries can send them to another runner.",
    subject: "Runner",
    count: "Jobs failed",
    minutes: "Failed minutes",
    action: { label: "Set up retries", href: "/router" },
  },
  "docs-changes": {
    title: "Docs changes run CI",
    about:
      "These workflows ran for commits or pull requests titled as docs changes, such as docs: fix a typo. Path filters let a workflow skip changes that only touch docs.",
    subject: "Workflow",
    count: "Docs runs",
    minutes: "Minutes",
    docs: "https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions#onpushpull_requestpull_request_targetpathspaths-ignore",
  },
  "wide-fanout": {
    title: "Full matrix on every branch",
    about:
      "These workflows started 10 or more jobs for a push or pull request on a branch other than your default. A smaller matrix before merge, with the full one on your default branch, still catches most problems.",
    subject: "Workflow",
    count: "Runs with 10+ jobs",
    minutes: "Minutes",
    docs: "https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/running-variations-of-jobs-in-a-workflow",
  },
};

// For local development without an API (auth disabled).
const WORKFLOWS = new Set(["CI", "Test", "E2E"]);

export function sampleSignals(days: number): SignalsReport {
  const scale = days / 30;
  const row = (
    repository: string,
    subject: string,
    count: number,
    minutes: number,
    cost: number,
  ) => ({
    repository,
    subject,
    // Workflow rows link to their file; job and runner rows don't.
    workflowPath: WORKFLOWS.has(subject) ? ".github/workflows/ci.yml" : null,
    count: Math.round(count * scale),
    minutes: Math.round(minutes * scale),
    cost: cost * scale,
  });
  const signal = (id: SignalId, rows: SignalRow[], area: SignalArea = "cost"): Signal => ({
    id,
    area,
    count: rows.reduce((total, r) => total + r.count, 0),
    minutes: rows.reduce((total, r) => total + r.minutes, 0),
    cost: rows.reduce((total, r) => total + r.cost, 0),
    rows,
  });
  return {
    days,
    totals: {
      jobs: Math.round(9400 * scale),
      minutes: Math.round(12_700 * scale),
      cost: 486 * scale,
    },
    signals: [
      signal(
        "queue-waits",
        [row("acme/web", "ubuntu-latest", 412, 1300, 0), row("acme/web", "macos-14", 96, 540, 0)],
        "speed",
      ),
      signal("slowest-job", [row("acme/web", "CI › e2e", 640, 920, 0)], "speed"),
      signal(
        "flaky-jobs",
        [
          row("acme/web", "CI › e2e", 34, 264, 11),
          row("acme/api", "Test › integration", 12, 96, 4),
        ],
        "speed",
      ),
      signal("no-concurrency", [
        row("acme/web", "CI", 143, 1116, 44),
        row("acme/api", "Test", 38, 240, 9),
      ]),
      signal("short-jobs", [
        row("acme/web", "Lint › lint", 1200, 520, 3.1),
        row("acme/api", "CI › typecheck", 1000, 410, 2.5),
      ]),
      signal("same-commit", [row("acme/web", "CI", 96, 552, 22)]),
      signal("docs-changes", [row("acme/web", "Test", 38, 366, 14)], "complexity"),
      signal("wide-fanout", [row("acme/web", "E2E", 120, 610, 24)], "complexity"),
    ],
    breakdown: sampleBreakdown(scale),
  };
}

// Sample Breakdown views that add up to the sample totals: 12.7K minutes and $486 over 30 days.
function sampleBreakdown(scale: number): Record<BreakdownBy, Breakdown> {
  type Sums = [runs: number, minutes: number, cost: number];
  const scaled = ([runs, minutes, cost]: Sums) => ({
    runs: Math.round(runs * scale),
    minutes: Math.round(minutes * scale),
    cost: cost * scale,
  });
  const view = (rows: [string, ...Sums, string?][], other?: Sums): Breakdown => ({
    rows: rows.map(([name, runs, minutes, cost, repository]) => ({
      name,
      repository: repository ?? null,
      workflowPath: repository && WORKFLOWS.has(name) ? ".github/workflows/ci.yml" : null,
      ...scaled([runs, minutes, cost]),
    })),
    other: other ? scaled(other) : null,
  });
  return {
    person: view(
      [
        ["jordan", 402, 3900, 151],
        ["ana", 288, 2800, 107],
        ["dependabot[bot]", 211, 1800, 68],
        ["sam", 139, 1400, 53],
        ["priya", 104, 1100, 44],
        ["lee", 30, 480, 19],
      ],
      [110, 1220, 44],
    ),
    repository: view([
      ["acme/web", 512, 6100, 233],
      ["acme/api", 389, 3500, 131],
      ["acme/mobile", 201, 1900, 73],
      ["acme/infra", 120, 700, 29],
      ["acme/docs", 62, 500, 20],
    ]),
    workflow: view(
      [
        ["CI", 388, 4300, 165, "acme/web"],
        ["E2E", 124, 2300, 87, "acme/web"],
        ["Test", 301, 2000, 78, "acme/api"],
        ["Build iOS", 64, 1100, 58, "acme/mobile"],
        ["Lint", 611, 1000, 24, "acme/web"],
      ],
      [120, 2000, 74],
    ),
    branch: view(
      [
        ["main", 301, 3500, 141],
        ["dependabot/npm_and_yarn/vite-8.1.0", 211, 1800, 68],
        ["jordan/checkout-v2", 97, 1700, 63],
        ["ana/search", 61, 1000, 39],
      ],
      [614, 4700, 175],
    ),
    trigger: view([
      ["push", 693, 6800, 262],
      ["pull_request", 411, 4100, 156],
      ["schedule", 96, 900, 34],
      ["workflow_dispatch", 61, 600, 24],
      ["rerun", 23, 300, 10],
    ]),
  };
}
