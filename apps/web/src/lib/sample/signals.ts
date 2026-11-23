// Signals and their runs for the dev preview (lib/sample/answers.ts), like GET /api/signals and
// /api/signals/runs.
import { sampleActor, sampleSha } from "./runs.ts";
import {
  type Breakdown,
  type BreakdownBy,
  FILTERED_MAX_DAYS,
  SIGNAL_COPY,
  type Signal,
  type SignalFilter,
  type SignalId,
  type SignalRow,
  type SignalRowRef,
  type SignalRun,
  type SignalRunsReport,
  type SignalTrend,
  type SignalsReport,
  isFiltered,
} from "../signals.ts";

// For local development without an API (auth disabled).
const WORKFLOWS = new Set(["CI", "Test", "E2E"]);

const SAMPLE_RUNNERS = new Set(["ubuntu-latest", "macos-14"]);

export function sampleSignals(days: number, filter: SignalFilter = {}): SignalsReport {
  const filtered = isFiltered(filter);
  if (filtered) days = Math.min(days, FILTERED_MAX_DAYS);
  // A filtered sample is about a third of everything.
  const scale = (days / 30) * (filtered ? 0.35 : 1);
  const row = (
    repository: string,
    subject: string,
    count: number,
    minutes: number,
    cost: number,
  ) => ({
    repository,
    subject,
    // Workflow rows link to their file; job rows don't, and runner rows open its panel.
    workflowPath: WORKFLOWS.has(subject) ? ".github/workflows/ci.yml" : null,
    runnerKey: SAMPLE_RUNNERS.has(subject) ? `github:${subject}` : null,
    count: Math.round(count * scale),
    minutes: Math.round(minutes * scale),
    cost: cost * scale,
  });
  const signal = (id: SignalId, rows: SignalRow[]): Signal => ({
    id,
    area: SIGNAL_COPY[id].area,
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
      signal("queue-waits", [
        row("acme/web", "ubuntu-latest", 412, 1300, 0),
        row("acme/web", "macos-14", 96, 540, 0),
      ]),
      signal("slowest-job", [row("acme/web", "CI › e2e", 640, 920, 0)]),
      signal("flaky-jobs", [
        row("acme/web", "CI › e2e", 34, 264, 11),
        row("acme/api", "Test › integration", 12, 96, 4),
      ]),
      signal("no-concurrency", [
        row("acme/web", "CI", 143, 1116, 44),
        row("acme/api", "Test", 38, 240, 9),
      ]),
      signal("short-jobs", [
        row("acme/web", "Lint › lint", 1200, 520, 3.1),
        row("acme/api", "CI › typecheck", 1000, 410, 2.5),
      ]),
      signal("same-commit", [row("acme/web", "CI", 96, 552, 22)]),
      signal("docs-changes", [row("acme/web", "Test", 38, 366, 14)]),
    ],
    breakdown: sampleBreakdown(scale),
    ...(filtered && { trend: sampleTrend(days, scale) }),
  };
}

function sampleTrend(days: number, scale: number): SignalTrend {
  const perDay = (12_700 * scale) / days;
  const wave = (day: number, lift: number) =>
    Math.max(
      0,
      Math.round(perDay * lift * (1 + 0.35 * Math.sin(day * 0.9) - (day % 7 > 4 ? 0.6 : 0))),
    );
  return {
    minutes: Array.from({ length: days }, (_, day) => wave(day, 1)),
    previous: Array.from({ length: days }, (_, day) => wave(day + 3, 0.82)),
  };
}

export function sampleSignalRuns(row: SignalRowRef, days: number): SignalRunsReport {
  const titles = [
    "Fix flaky checkout test",
    "Add search filters",
    "Bump vite to 8.1",
    "Docs: API keys",
  ];
  const runs = Array.from({ length: 8 }, (_, n): SignalRun => ({
    repositoryId: 1,
    repository: row.repository,
    runId: 9_000 - n,
    runAttempt: 1,
    jobId: row.subject.includes("›") ? 90_000 - n : null,
    workflow: row.subject.split(" › ")[0] ?? null,
    title: titles[n % titles.length]!,
    event: n % 3 === 0 ? "push" : "pull_request",
    branch: n % 3 === 0 ? "main" : `feature-${n}`,
    sha: sampleSha(n),
    actor: sampleActor(n),
    conclusion: row.signal === "flaky-jobs" || n % 4 === 1 ? "failure" : "success",
    startedAt: Date.now() - (n * 7 + 1) * 3_600_000,
    runMs: (4 + ((n * 5) % 11)) * 60_000 + n * 7_000,
    cost: 0.1 * (n + 1),
  }));
  return { days: Math.min(days, FILTERED_MAX_DAYS), runs, total: 34 };
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
    // Pull request runs only, each under every folder it changed, so these overlap.
    path: view([
      ["apps/web", 302, 3100, 119, "acme/web"],
      ["packages/ui", 141, 1600, 61, "acme/web"],
      ["src", 188, 1500, 57, "acme/api"],
      ["docs", 64, 700, 26, "acme/web"],
      ["/", 52, 400, 15, "acme/api"],
    ]),
  };
}
