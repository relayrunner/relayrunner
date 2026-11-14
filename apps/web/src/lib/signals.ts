import { CircleDollarSignIcon, GaugeIcon, LayersIcon, type LucideIcon } from "lucide-react";
import { DOCS_URL } from "@/components/site-footer";
import { api } from "@/lib/api";

export type SignalArea = "speed" | "cost" | "complexity";
export type SignalId =
  | "no-concurrency"
  | "same-commit"
  | "short-jobs"
  | "queue-waits"
  | "slowest-job"
  | "flaky-jobs";

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

/** GET /api/signals: the signals over the threshold, the most time first. */
export type SignalsReport = {
  days: number;
  totals: { jobs: number; minutes: number; cost: number };
  signals: Signal[];
};

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
      "These jobs failed and then passed when the run was tried again, so the failure likely wasn't the change. Minutes and spend are the failed attempts.",
    subject: "Job",
    count: "Passed on re-run",
    minutes: "Failed minutes",
  },
};

// For local development without an API (auth disabled).
const WORKFLOWS = new Set(["CI", "Test"]);

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
    ],
  };
}
