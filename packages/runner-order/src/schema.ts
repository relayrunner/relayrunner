import { HOSTED_PROVIDER_IDS } from "@relayrunner/providers";
import { z } from "zod";
import {
  DEFAULT_RETRY_SETTINGS,
  DEFAULT_RUNNER_ORDER,
  hasSpendLimit,
  RETRY_RUNNERS,
  RUNNER_LABELS,
  stepSlot,
} from "./core.ts";

// The Zod schemas for a runner order and retry settings, and the readers for their stored
// columns. Kept apart from core.ts so code that only needs the constants doesn't load Zod.

/**
 * "While under a limit": the GitHub step passes a job on once the job's GitHub account has used
 * `percent` of its included minutes this month (#117). A step without one always takes the job.
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
 * "While under $X a month": a hosted provider step passes a job on once the job's GitHub account
 * has spent `usd` on that provider this calendar month (UTC), at list prices. Only providers with
 * list prices (SPEND_LIMIT_PROVIDERS) can count spend.
 */
export const spendLimitSchema = z.object({
  usd: z
    .number()
    .int("Use whole dollars.")
    .min(1, "Pick a limit from $1 to $100,000.")
    .max(100_000, "Pick a limit from $1 to $100,000."),
});
export type SpendLimit = z.infer<typeof spendLimitSchema>;

export const runnerStepSchema = z.discriminatedUnion("key", [
  z.object({ key: z.literal("machine") }),
  z.object({ key: z.literal("github"), limit: minutesLimitSchema.optional() }),
  // A hosted provider: it takes any job whose relay names one of its labels.
  z.object({ key: z.enum(HOSTED_PROVIDER_IDS), spendLimit: spendLimitSchema.optional() }),
]);
export type RunnerStep = z.infer<typeof runnerStepSchema>;

export const runnerOrderSchema = z.object({
  steps: z
    .array(runnerStepSchema)
    .min(1, "Add at least one provider.")
    .superRefine((steps, ctx) => {
      // Each provider once, except GitHub-hosted, which may come twice: once with a limit and once
      // without (use the included minutes first, then fall back to GitHub past the limit).
      const seen = new Set<string>();
      steps.forEach((step, index) => {
        const slot = stepSlot(step);
        if (seen.has(slot)) {
          ctx.addIssue({
            code: "custom",
            path: [index, "key"],
            message:
              step.key === "github"
                ? `GitHub-hosted is already in the order ${step.limit ? "with a limit" : "without a limit"}.`
                : `${RUNNER_LABELS[step.key]} is already in the order.`,
          });
        }
        seen.add(slot);
        if ("spendLimit" in step && step.spendLimit && !hasSpendLimit(step.key))
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
