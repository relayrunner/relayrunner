import {
  FREE_MINUTES,
  isFreeMinutesProvider,
  RUNNER_LABELS,
  type RunnerStep,
} from "@relayrunner/runner-order";
import { hasQuota, type AccountUsage } from "./actions-usage";
import { type FreeMinutesByProvider, noFreeMinutes } from "./free-minutes";

// What the Router's steps say about their spend caps: each cap button, the connector text that
// says what hands a job on to the next step, and where a usage bar's cap tick sits.

/** The one GitHub account's included minutes, when exactly one connected account has a quota. */
export function githubQuota(accounts: AccountUsage[]) {
  const withQuota = accounts.filter(hasQuota);
  return withQuota.length === 1 ? withQuota[0]!.quotaMinutes! : null;
}

/**
 * Whether a step's minutes limit has nothing to count: its provider says the plan has no free
 * minutes (Groundbox's sponsored and paid plans), so the Router never stops at it.
 */
function limitHasNoMinutes(step: RunnerStep, free: FreeMinutesByProvider) {
  return isFreeMinutesProvider(step.key) && noFreeMinutes(free[step.key]);
}

/** A step's minutes quota: GitHub's included minutes, or a provider's free minutes. */
function quotaOf(step: RunnerStep, accounts: AccountUsage[], free: FreeMinutesByProvider) {
  if (step.key === "github") return githubQuota(accounts);
  if (!isFreeMinutesProvider(step.key)) return null;
  return free[step.key]?.quotaMinutes ?? FREE_MINUTES[step.key];
}

export const minutes = (n: number) => Math.round(n).toLocaleString("en-US");

/** A step's spend cap as its button reads: "Up to 2,400 minutes", "Up to $100 a month" or "No cap". */
export function capText(
  step: RunnerStep,
  accounts: AccountUsage[],
  free: FreeMinutesByProvider = {},
) {
  if (step.key === "machine") return "When available";
  if ("limit" in step && step.limit) {
    if (limitHasNoMinutes(step, free)) return "No minutes to track";
    const { percent } = step.limit;
    // Each GitHub account has its own quota, so with several the cap is a range.
    const quotas =
      step.key === "github"
        ? accounts.filter(hasQuota).map((account) => account.quotaMinutes!)
        : [quotaOf(step, accounts, free)].filter((quota) => quota !== null);
    if (quotas.length === 0) return `Up to ${percent}% of minutes`;
    const low = minutes((Math.min(...quotas) * percent) / 100);
    const high = minutes((Math.max(...quotas) * percent) / 100);
    return `Up to ${low === high ? low : `${low}–${high}`} minutes`;
  }
  if ("spendLimit" in step && step.spendLimit)
    return `Up to $${step.spendLimit.usd.toLocaleString("en-US")} a month`;
  return "No cap";
}

/**
 * What sends a job on from `prev` to the next step, said in terms of how `prev` is set up. A
 * provider with no cap takes every job it can start, so the steps below it rarely run: `warn`.
 * Boat is the exception once it's connected (`boatConnected`), since the Router then passes jobs
 * on when Boat's plan runs out of job starts; until then, `connect` offers the connection. So is a
 * connected Groundbox, whose step passes on the jobs Groundbox would hold.
 */
export function handoffText(
  prev: RunnerStep,
  accounts: AccountUsage[],
  free: FreeMinutesByProvider,
  boatConnected = false,
): Handoff {
  if (prev.key === "machine") return { text: "When every machine is busy or offline", warn: false };
  const label = RUNNER_LABELS[prev.key];
  // A limit on free minutes the plan doesn't have never stops a job: the step reads as uncapped.
  if ("limit" in prev && prev.limit && !limitHasNoMinutes(prev, free)) {
    const quota = quotaOf(prev, accounts, free);
    if (quota === null)
      return { text: `Once ${prev.limit.percent}% of included minutes are used`, warn: false };
    const cap = minutes((quota * prev.limit.percent) / 100);
    return {
      text: prev.key !== "github" ? `Once ${cap} free min are used` : `Once ${cap} min are used`,
      warn: false,
    };
  }
  if ("spendLimit" in prev && prev.spendLimit)
    return {
      text: `Once $${prev.spendLimit.usd.toLocaleString("en-US")} is spent this month`,
      warn: false,
    };
  if (prev.key === "boat") {
    if (boatConnected)
      return { text: "When Boat reaches its plan's limit on job starts", warn: false };
    return {
      text: "Boat takes every job it can start, so the steps below rarely run",
      warn: true,
      connect: "Connect Boat",
    };
  }
  // Connected, Groundbox's step passes jobs on that Groundbox would hold (out of credit, at its
  // own spend cap, or the account held).
  if (prev.key === "groundbox" && free.groundbox && free.groundbox.reason !== "not_connected")
    return { text: "When Groundbox would hold the job", warn: false };
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

/** `connect`: a link to Settings › Providers, for a provider whose connection would stop the warning. */
export type Handoff = { text: string; warn: boolean; connect?: string };

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
