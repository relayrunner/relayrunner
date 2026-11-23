// What a job's minutes cost: the runner class its labels ask for, GitHub's rate for that class at a
// moment, and how GitHub rounds a job's time to billed minutes.
import { sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import {
  GITHUB_LABELS,
  type GitHubRunner,
  githubRate,
  type PriceBook,
} from "@relayrunner/providers";
import { routeIdFromLabels } from "../routing/routing.ts";

// GitHub bills a job by the minute, rounded up. A job that finishes in under this is the free-checks
// opportunity: it pays for a whole minute however little of it ran.
export const SHORT_JOB_SECONDS = 60;

/**
 * Which per-minute rate a job pays. GitHub-hosted classes follow GitHub's standard runner prices;
 * `self-hosted` covers a self-hosted runner (including RelayRunner's own picks and machines), which
 * GitHub doesn't charge for. `other` is a label we can't price, such as a larger runner, and is
 * counted at the `ubuntu-latest` rate, so the estimate is a floor.
 */
export type RunnerClass = GitHubRunner | "self-hosted" | "other";

/** GitHub's standard runners go by the label its docs give them, such as `ubuntu-slim`. */
export const RUNNER_LABELS: Record<RunnerClass, string> = {
  ...GITHUB_LABELS,
  macos: "macOS",
  "self-hosted": "Self-hosted",
  other: `Other (priced as ${GITHUB_LABELS["linux-2-core"]})`,
};

/** What a minute cost on a runner class in a private repo at `at` (epoch ms, now by default). */
export function classRate(book: PriceBook, cls: RunnerClass, at = Date.now()) {
  if (cls === "self-hosted") return 0;
  return githubRate(book, cls === "other" ? "linux-2-core" : cls, at) ?? 0;
}

/**
 * What a minute cost on a runner class in a repo: standard runners are free in public repos, and
 * unknown visibility counts as private, so a missing mirror row never hides a cost.
 */
export function rateFor(
  book: PriceBook,
  cls: RunnerClass,
  isPrivate: boolean | null | undefined,
  at = Date.now(),
) {
  return isPrivate === false ? 0 : classRate(book, cls, at);
}

/**
 * Splits a report's window where prices changed, so each stretch is priced at what a minute cost
 * then. `period` is SQL for which stretch a row's time (`column`, epoch ms) falls in, to select;
 * `groupBy` is what to add to the query's grouping (nothing when no price changed in the window,
 * so the split adds no rows); `at` turns a period back into a moment inside its stretch.
 */
export function pricePeriods(book: PriceBook, column: SQLiteColumn, since: number, now: number) {
  const changes = book.changes.filter((change) => change > since && change <= now);
  const period = changes.length
    ? sql<number>`(${sql.join(
        changes.map((change) => sql`(${column} >= ${change})`),
        sql` + `,
      )})`
    : sql<number>`0`;
  return {
    period,
    groupBy: changes.length ? [period] : [],
    at: (period: number) => (period > 0 ? changes[period - 1]! : since),
  };
}

export const GITHUB_HOSTED_GROUP = "GitHub Actions";

/**
 * Classifies a job by its runs-on labels and, once a runner took it, the runner's group. Applied when
 * the report is read, so changing the rules or the rates needs no backfill.
 */
export function runnerClass(labels: string[], runnerGroupName?: string | null): RunnerClass {
  const lower = labels.map((label) => label.toLowerCase());
  // A pick (`runs-on: relayrunner`) or a route's machine is self-hosted too.
  if (lower.includes("self-hosted") || lower.includes("relayrunner") || routeIdFromLabels(labels))
    return "self-hosted";
  // A runner group other than GitHub's own means the org's runners, unless the labels name a hosted
  // image (larger hosted runners can sit in custom groups).
  const hosted = lower.find((label) => /^(ubuntu|windows|macos|xcode)-/.test(label));
  if (!hosted)
    return runnerGroupName && runnerGroupName !== GITHUB_HOSTED_GROUP ? "self-hosted" : "other";
  // macos-latest, macos-15-intel, xcode-27: GitHub prices every macOS image the same.
  if (hosted.startsWith("macos") || hosted.startsWith("xcode")) return "macos";
  if (/^windows-11(-vs\d{4})?-arm$/.test(hosted)) return "windows-arm-2-core";
  if (hosted.startsWith("windows"))
    return /^windows-(latest|\d{4}(-vs\d{4})?)$/.test(hosted) ? "windows-2-core" : "other";
  if (hosted === "ubuntu-slim") return "linux-1-core";
  const ubuntu = /^ubuntu-(latest|\d{2}\.\d{2})(-arm)?$/.exec(hosted);
  if (ubuntu) return ubuntu[2] ? "linux-arm-2-core" : "linux-2-core";
  return "other";
}

/** The minutes GitHub bills a job that ran `ms`: rounded up, at least one (BILLED_MINUTES in SQL). */
export const billedMinutes = (ms: number) => Math.max(1, Math.ceil(ms / 60_000));

// Keeps sub-cent precision (a 1-core minute is $0.002) without float noise.
export function cents(value: number) {
  return Math.round(value * 1000) / 1000;
}
