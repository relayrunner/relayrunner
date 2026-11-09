import { RUNNER_LABELS, type RunnerStep } from "@relayrunner/runner-order";
import { hasQuota, type AccountUsage } from "./actions-usage.ts";
import type { Machine } from "./machines.ts";

/**
 * Where a private-repo job that names every provider would go right now, worked out in the
 * browser from the order, the machines' live status and this month's Actions minutes. The Router
 * (apps/api routing.ts) decides for real; this only explains the order on the Router page.
 */
export type StepVerdict = {
  /** next: this step takes the job. skipped: it would pass the job on. unreached: an earlier step takes it. */
  state: "next" | "skipped" | "unreached";
  reason: string;
};

export type RoutePreview = {
  steps: StepVerdict[];
  /** Null when no step would take the job. */
  next: { title: string; why: string } | null;
};

/** The account whose minutes are furthest along, as a share of its quota. */
export function mostUsed(accounts: AccountUsage[]) {
  let worst: { account: AccountUsage; percent: number } | null = null;
  for (const account of accounts.filter(hasQuota)) {
    const percent = Math.floor((account.usedMinutes / account.quotaMinutes!) * 100);
    if (!worst || percent > worst.percent) worst = { account, percent };
  }
  return worst;
}

function machineVerdict(machines: Machine[]): { takes: boolean; reason: string; name?: string } {
  const active = machines.filter((machine) => !machine.revokedAt);
  const online = active.filter((machine) => machine.status?.online);
  const ready = online.filter((machine) => !machine.paused);
  const idle = ready.find((machine) => machine.status?.state !== "busy");
  if (idle) return { takes: true, reason: `${idle.name} is idle`, name: idle.name };
  if (active.length === 0) return { takes: false, reason: "No self-hosted runner is connected" };
  if (online.length === 0)
    return {
      takes: false,
      reason:
        active.length === 1 ? `${active[0]!.name} is offline` : "No self-hosted runner is online",
    };
  if (ready.length === 0)
    return {
      takes: false,
      reason:
        online.length === 1 ? `${online[0]!.name} is paused` : "Every online runner is paused",
    };
  return {
    takes: false,
    reason:
      ready.length === 1
        ? `${ready[0]!.name} is busy with a job`
        : `All ${ready.length} online runners are busy`,
  };
}

export function previewRoute(
  steps: RunnerStep[],
  machines: Machine[],
  accounts: AccountUsage[],
): RoutePreview {
  const worst = mostUsed(accounts);
  const many = accounts.filter(hasQuota).length > 1;
  const verdicts: StepVerdict[] = [];
  const skipped: string[] = [];
  let next: RoutePreview["next"] = null;

  for (const step of steps) {
    if (next) {
      verdicts.push({ state: "unreached", reason: "" });
      continue;
    }
    let takes = true;
    let reason = `${RUNNER_LABELS[step.key]} takes every job`;
    let title: string = RUNNER_LABELS[step.key];
    if (step.key === "machine") {
      const verdict = machineVerdict(machines);
      takes = verdict.takes;
      reason = verdict.reason;
      if (verdict.name) title = `Self-hosted · ${verdict.name}`;
    } else if (step.key === "github" && step.limit) {
      if (!worst) reason = "No minutes quota to check against, so GitHub takes it";
      else {
        const who = many ? `${worst.account.accountLogin} has used` : "Used";
        const { account } = worst;
        const left = account.quotaMinutes! * (step.limit.percent / 100) - account.usedMinutes;
        // The Router also stops early when less than two hours of burn are left (#117).
        const runwayShort = account.burnRatePerHour !== null && left < 2 * account.burnRatePerHour;
        takes = worst.percent < step.limit.percent && !runwayShort;
        reason =
          worst.percent < step.limit.percent && runwayShort
            ? `${who} ${worst.percent}% of included minutes, under 2 hours from the ${step.limit.percent}% limit`
            : `${who} ${worst.percent}% of included minutes, ${takes ? "under" : "past"} the ${step.limit.percent}% limit`;
      }
    } else if (step.key === "github" && worst && worst.percent >= 100) {
      reason = "Past the included minutes, so GitHub bills overage";
    }
    if (takes) {
      next = { title, why: skipped.length ? skipped.join(" · ") : reason };
      verdicts.push({ state: "next", reason });
    } else {
      skipped.push(reason);
      verdicts.push({ state: "skipped", reason });
    }
  }
  return { steps: verdicts, next };
}
