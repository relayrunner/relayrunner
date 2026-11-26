// Usage and free-check savings for the dev preview (lib/sample/answers.ts).
import type { FreeCheckSavings, UsageReport, UsageRow } from "@/lib/usage";

const TOTAL_KEYS = [
  "jobs",
  "shortJobs",
  "runSeconds",
  "billedMinutes",
  "shortBilledMinutes",
  "cost",
  "shortCost",
  "roundingCost",
] as const satisfies (keyof UsageReport["totals"])[];

/** Example usage over `days`. */
export function sampleUsageReport(days: number): UsageReport {
  const scale = days / 30;
  const row = (
    runnerClass: string,
    label: string,
    perMinute: number,
    jobs: number,
    shortJobs: number,
    billedMinutes: number,
  ): UsageRow => {
    const j = Math.round(jobs * scale);
    const s = Math.round(shortJobs * scale);
    const b = Math.round(billedMinutes * scale);
    return {
      runnerClass,
      label,
      perMinute,
      jobs: j,
      shortJobs: s,
      runSeconds: b * 40,
      billedMinutes: b,
      shortBilledMinutes: s,
      cost: b * perMinute,
      shortCost: s * perMinute,
      roundingCost: b * perMinute * 0.33,
    };
  };
  const byRunner = [
    row("macos", "macOS", 0.062, 120, 40, 900),
    row("linux-2-core", "ubuntu-latest", 0.006, 2400, 1500, 6200),
    row("self-hosted", "Self-hosted", 0, 300, 90, 1400),
  ];
  return {
    days,
    shortJobSeconds: 60,
    totals: Object.fromEntries(
      TOTAL_KEYS.map((key) => [key, byRunner.reduce((total, r) => total + r[key], 0)]),
    ) as UsageReport["totals"],
    byRunner,
    byRepository: [
      { repository: "acme/app", private: true, jobs: 1800, shortJobs: 1100, shortCost: 8.9 },
      { repository: "acme/docs", private: false, jobs: 400, shortJobs: 380, shortCost: 0 },
    ],
  };
}

/** Example savings from the free checks over `days`. */
export function sampleCheckSavings(days: number): FreeCheckSavings {
  const perMinute = 0.006;
  const title = Math.round(110 * (days / 30));
  const lint = Math.round(90 * (days / 30));
  // PR title checks in both repos, lint only in acme/app.
  const docs = Math.round(title * 0.55);
  const app = title - docs + lint;
  return {
    days,
    runner: { label: "ubuntu-latest", perMinute },
    checks: title + lint,
    savedCost: app * perMinute,
    byCheck: [
      { check: "PR title", checks: title, savedCost: (title - docs) * perMinute },
      { check: "Lint", checks: lint, savedCost: lint * perMinute },
    ],
    byRepository: [
      { repository: "acme/app", private: true, checks: app, savedCost: app * perMinute },
      { repository: "acme/docs", private: false, checks: docs, savedCost: 0 },
    ],
  };
}
