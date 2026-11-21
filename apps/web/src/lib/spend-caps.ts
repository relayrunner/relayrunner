import { BLACKSMITH_FREE_MINUTES, RUNNER_LABELS, type RunnerStep } from "@relayrunner/runner-order";
import { hasQuota, type AccountUsage } from "./actions-usage";
import type { BlacksmithMinutes } from "./blacksmith-minutes";

// What the Router's steps say about their spend caps: each cap button, the connector text that
// says what hands a job on to the next step, and where a usage bar's cap tick sits.

/** The one GitHub account's included minutes, when exactly one connected account has a quota. */
export function githubQuota(accounts: AccountUsage[]) {
  const withQuota = accounts.filter(hasQuota);
  return withQuota.length === 1 ? withQuota[0]!.quotaMinutes! : null;
}

function blacksmithQuota(blacksmith: BlacksmithMinutes | null) {
  return blacksmith?.quotaMinutes ?? BLACKSMITH_FREE_MINUTES;
}

export const minutes = (n: number) => Math.round(n).toLocaleString("en-US");

/** A step's spend cap as its button reads: "Cap 2,400 min", "Cap $100/mo" or "No cap". */
export function capText(
  step: RunnerStep,
  accounts: AccountUsage[],
  blacksmith: BlacksmithMinutes | null,
) {
  if (step.key === "machine") return "When available";
  if ("limit" in step && step.limit) {
    const quota = step.key === "github" ? githubQuota(accounts) : blacksmithQuota(blacksmith);
    if (quota === null) return `Cap ${step.limit.percent}%`;
    const cap = minutes((quota * step.limit.percent) / 100);
    return step.key === "blacksmith" ? `Cap ${cap} free min` : `Cap ${cap} min`;
  }
  if ("spendLimit" in step && step.spendLimit)
    return `Cap $${step.spendLimit.usd.toLocaleString("en-US")}/mo`;
  return "No cap";
}

/**
 * What sends a job on from `prev` to the next step, said in terms of how `prev` is set up. A
 * provider with no cap takes every job it can start, so the steps below it rarely run: `warn`.
 */
export function handoffText(
  prev: RunnerStep,
  accounts: AccountUsage[],
  blacksmith: BlacksmithMinutes | null,
): Handoff {
  if (prev.key === "machine") return { text: "When every machine is busy or offline", warn: false };
  const label = RUNNER_LABELS[prev.key];
  if ("limit" in prev && prev.limit) {
    const quota = prev.key === "github" ? githubQuota(accounts) : blacksmithQuota(blacksmith);
    if (quota === null)
      return { text: `Once ${prev.limit.percent}% of included minutes are used`, warn: false };
    const cap = minutes((quota * prev.limit.percent) / 100);
    return {
      text:
        prev.key === "blacksmith" ? `Once ${cap} free min are used` : `Once ${cap} min are used`,
      warn: false,
    };
  }
  if ("spendLimit" in prev && prev.spendLimit)
    return {
      text: `Once $${prev.spendLimit.usd.toLocaleString("en-US")} is spent this month`,
      warn: false,
    };
  return {
    text: `${label} takes every job it can start, so the steps below rarely run`,
    warn: true,
  };
}

/**
 * Why a step can never take a job, or null when it can: the same provider earlier in the order
 * with the same kind of cap set at least as high has already passed on every job this one would
 * see ("Blacksmith to 90%, then Blacksmith to 50%"). An uncapped step above is the connector's
 * warning instead.
 */
export function unreachableText(steps: RunnerStep[], index: number) {
  const step = steps[index]!;
  if (step.key === "machine") return null;
  const cap = capOf(step);
  if (!cap) return null;
  const above = steps.slice(0, index).some((prev) => {
    const prevCap = prev.key === step.key ? capOf(prev) : null;
    return prevCap?.kind === cap.kind && prevCap.value >= cap.value;
  });
  return above
    ? `Never reached: the ${RUNNER_LABELS[step.key]} step above has the same or a higher cap.`
    : null;
}

function capOf(step: RunnerStep) {
  if ("limit" in step && step.limit) return { kind: "minutes", value: step.limit.percent };
  if ("spendLimit" in step && step.spendLimit) return { kind: "spend", value: step.spendLimit.usd };
  return null;
}

export type Handoff = { text: string; warn: boolean };

/** How close a cap's tick may come to either end of its bar, in percent. */
const TICK_EDGE = 10;

/**
 * Where a bar's fill ends and its cap tick sits, in percent. The bar measures up to `full`
 * (a quota, or for a dollar cap a little past the cap), stretched or shrunk so the tick stays
 * TICK_EDGE from either end.
 */
export function barMarks(used: number, cap: number, full: number) {
  const scale = Math.min(Math.max(full, cap / ((100 - TICK_EDGE) / 100)), cap / (TICK_EDGE / 100));
  return { fill: Math.min((used / scale) * 100, 100), tick: (cap / scale) * 100 };
}
