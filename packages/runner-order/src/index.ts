import { HOSTED_PROVIDER_IDS, PROVIDERS } from "@relayrunner/providers";
import { z } from "zod";

// A workspace's runner order: an ordered allowlist of providers. The Router walks it top to
// bottom and a job goes to the first provider that the job configures (relay.yml's input of the
// same name, such as `machine`, `github` or `depot`) and that can take it. A provider missing from the order is never picked,
// and a job nothing fits fails fast. Labels come from the job, so a step is a key plus, for
// GitHub-hosted, an optional minutes limit (#117).

/** Every provider a step can name, in the order the dashboard offers them. */
export const RUNNER_KEYS = ["machine", "github", ...HOSTED_PROVIDER_IDS] as const;
export type RunnerKey = (typeof RUNNER_KEYS)[number];

/** A record with an entry for every provider. */
export function byRunnerKey<T>(value: (key: RunnerKey) => T): Record<RunnerKey, T> {
  return Object.fromEntries(RUNNER_KEYS.map((key) => [key, value(key)])) as Record<RunnerKey, T>;
}

/** A relay's inputs: the labels it names for each provider, empty for one it leaves out. */
export type RelayInputs = Record<RunnerKey, string[]>;

/** Just the relay inputs out of anything that carries them, every provider present. */
export const relayInputs = (from: Partial<RelayInputs>): RelayInputs =>
  byRunnerKey((key) => from[key] ?? []);

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
  // A hosted provider: it takes any job whose relay names one of its labels.
  z.object({ key: z.enum(HOSTED_PROVIDER_IDS) }),
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
export const RUNNER_LABELS = byRunnerKey((key) =>
  key === "machine" ? "Self-hosted" : key === "github" ? "GitHub-hosted" : PROVIDERS[key].name,
);

/** A label each provider's relay input takes, such as `depot-ubuntu-24.04`. */
export const RUNNER_EXAMPLES = byRunnerKey((key) =>
  key === "machine" ? "self-hosted" : PROVIDERS[key].example!,
);

/**
 * Why a hosted provider's step skipped a job whose input names a label it doesn't serve, after the
 * input's name: "takes a Depot label such as depot-ubuntu-24.04, not ubuntu-latest".
 */
export const notProviderLabelText = (key: RunnerKey, labels: string[]) =>
  `takes a ${RUNNER_LABELS[key]} label such as ${RUNNER_EXAMPLES[key]}, not ${labels.join(", ")}`;

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

/**
 * Where an automatic retry goes: `any` the same runner if it's free, else the next that fits;
 * `same` the runner that failed, first; `other` the rest of the order first, the one that failed
 * last.
 */
export const RETRY_RUNNERS = ["any", "same", "other"] as const;
export type RetryRunner = (typeof RETRY_RUNNERS)[number];

/** A workspace's automatic retries: off unless turned on, at most `max` retries per run. */
export const retrySettingsSchema = z.object({
  enabled: z.boolean(),
  runner: z.enum(RETRY_RUNNERS),
  max: z.number().int().min(1).max(2),
});
export type RetrySettings = z.infer<typeof retrySettingsSchema>;

export const DEFAULT_RETRY_SETTINGS: RetrySettings = { enabled: false, runner: "any", max: 1 };

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
