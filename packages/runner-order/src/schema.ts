import { HOSTED_PROVIDER_IDS, type HostedProviderId } from "@relayrunner/providers";
import { z } from "zod";
import {
  DEFAULT_RETRY_SETTINGS,
  DEFAULT_RUNNER_ORDER,
  hasSpendLimit,
  RETRY_RUNNERS,
  RUNNER_LABELS,
} from "./core.ts";

// The Zod schemas for a runner order and retry settings, and the readers for their stored
// columns. Kept apart from core.ts so code that only needs the constants doesn't load Zod.

/**
 * "While under a limit": the GitHub step passes a job on once the job's GitHub account has used
 * `percent` of its included minutes this month (#117), and the Blacksmith step once the workspace
 * has used `percent` of Blacksmith's free minutes (counted only with Blacksmith connected in
 * Settings › Providers). A step without one always takes the job.
 */
export const minutesLimitSchema = z.object({
  percent: z
    .number()
    .int()
    .min(1, "Pick a limit from 1 to 100%.")
    .max(100, "Pick a limit from 1 to 100%."),
});
export type MinutesLimit = z.infer<typeof minutesLimitSchema>;

/**
 * A spend cap: a hosted provider step passes a job on once the job's GitHub account has spent
 * `usd` on that provider this calendar month (UTC), at list prices. Only providers with list
 * prices (SPEND_LIMIT_PROVIDERS) can count spend. On GitHub-hosted it's what GitHub billed the
 * account for Actions this month, as its billing reports it.
 */
export const spendLimitSchema = z.object({
  usd: z
    .number()
    .int("Use whole dollars.")
    .min(1, "Pick a limit from $1 to $100,000.")
    .max(100_000, "Pick a limit from $1 to $100,000."),
});
export type SpendLimit = z.infer<typeof spendLimitSchema>;

type OtherHostedId = Exclude<HostedProviderId, "blacksmith">;
const OTHER_HOSTED_IDS = HOSTED_PROVIDER_IDS.filter(
  (id): id is OtherHostedId => id !== "blacksmith",
) as [OtherHostedId, ...OtherHostedId[]];

export const runnerStepSchema = z.discriminatedUnion("key", [
  z.object({ key: z.literal("machine") }),
  // GitHub: its included minutes, or what it bills past them (read from GitHub billing).
  z.object({
    key: z.literal("github"),
    limit: minutesLimitSchema.optional(),
    spendLimit: spendLimitSchema.optional(),
  }),
  // Blacksmith: a hosted provider whose free minutes RelayRunner can count, once connected.
  z.object({
    key: z.literal("blacksmith"),
    limit: minutesLimitSchema.optional(),
    spendLimit: spendLimitSchema.optional(),
  }),
  // A hosted provider: it takes any job whose relay names one of its labels.
  z.object({ key: z.enum(OTHER_HOSTED_IDS), spendLimit: spendLimitSchema.optional() }),
]);
export type RunnerStep = z.infer<typeof runnerStepSchema>;

export const runnerOrderSchema = z.object({
  steps: z
    .array(runnerStepSchema)
    .min(1, "Add at least one provider.")
    .superRefine((steps, ctx) => {
      // A provider may come back any number of times with any cap (Blacksmith to 50%, GitHub to
      // 80%, Blacksmith to 90%, then GitHub). Self-hosted comes once: a second step would see the
      // same machines.
      let machine = false;
      steps.forEach((step, index) => {
        if (step.key === "machine") {
          if (machine)
            ctx.addIssue({
              code: "custom",
              path: [index, "key"],
              message: `${RUNNER_LABELS.machine} is already in the order.`,
            });
          machine = true;
        }
        if ("limit" in step && step.limit && "spendLimit" in step && step.spendLimit)
          ctx.addIssue({
            code: "custom",
            path: [index, "spendLimit"],
            message: "Pick a minutes limit or a spend limit, not both.",
          });
        // GitHub's spend comes from its own billing; other providers' from list prices.
        if (
          "spendLimit" in step &&
          step.spendLimit &&
          step.key !== "github" &&
          !hasSpendLimit(step.key)
        )
          ctx.addIssue({
            code: "custom",
            path: [index, "spendLimit"],
            message: `${RUNNER_LABELS[step.key]} has no list prices, so its spend can't be counted.`,
          });
      });
    }),
});
export type RunnerOrder = z.infer<typeof runnerOrderSchema>;

/**
 * The stored column's value as an order. A missing or unreadable value reads as the default,
 * so routing never stalls on a bad row.
 */
export function readRunnerOrder(stored: string | null | undefined): RunnerOrder {
  if (!stored) return DEFAULT_RUNNER_ORDER;
  try {
    const parsed = runnerOrderSchema.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : DEFAULT_RUNNER_ORDER;
  } catch {
    return DEFAULT_RUNNER_ORDER;
  }
}

/** A workspace's automatic retries: off unless turned on, at most `max` retries per run. */
export const retrySettingsSchema = z.object({
  enabled: z.boolean(),
  runner: z.enum(RETRY_RUNNERS),
  max: z.number().int().min(1).max(2),
});
export type RetrySettings = z.infer<typeof retrySettingsSchema>;

/** The stored column's value as settings. Missing or unreadable reads as off. */
export function readRetrySettings(stored: string | null | undefined): RetrySettings {
  if (!stored) return DEFAULT_RETRY_SETTINGS;
  try {
    const parsed = retrySettingsSchema.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : DEFAULT_RETRY_SETTINGS;
  } catch {
    return DEFAULT_RETRY_SETTINGS;
  }
}
