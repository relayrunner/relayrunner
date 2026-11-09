import { z } from "zod";

// A workspace's runner order: an ordered allowlist of providers. The Router walks it top to
// bottom and a job goes to the first provider that the job configures (relay.yml's `machine`,
// `github` and `blacksmith` inputs) and that can take it. A provider missing from the order is never picked,
// and a job nothing fits fails fast. Labels come from the job, so a step is a key plus, for
// GitHub-hosted, an optional minutes limit (#117).

/** Every provider a step can name, in the order the dashboard offers them. */
export const RUNNER_KEYS = ["machine", "github", "blacksmith"] as const;
export type RunnerKey = (typeof RUNNER_KEYS)[number];

/** The share of an account's included Actions minutes a limited GitHub step uses by default. */
export const DEFAULT_LIMIT_PERCENT = 80;

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

export const runnerStepSchema = z.discriminatedUnion("key", [
  z.object({ key: z.literal("machine") }),
  z.object({ key: z.literal("github"), limit: minutesLimitSchema.optional() }),
  z.object({ key: z.literal("blacksmith") }),
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
      });
    }),
});
export type RunnerOrder = z.infer<typeof runnerOrderSchema>;

/** What a workspace that never saved an order gets: a free local machine, then GitHub-hosted. */
export const DEFAULT_RUNNER_ORDER: RunnerOrder = {
  steps: [{ key: "machine" }, { key: "github" }],
};

/** What makes a step unique in an order: its provider, and for GitHub whether it has a limit. */
export function stepSlot(step: RunnerStep) {
  return step.key === "github" && step.limit ? "github:limit" : step.key;
}

/** How the dashboard names each provider. */
export const RUNNER_LABELS: Record<RunnerKey, string> = {
  machine: "Self-hosted",
  github: "GitHub-hosted",
  blacksmith: "Blacksmith",
};

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
