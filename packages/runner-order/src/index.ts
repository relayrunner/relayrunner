import { HOSTED_PROVIDER_IDS, hasListPrices, PROVIDERS } from "@relayrunner/providers";
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

/** What a new spend limit starts at, in dollars a month. */
export const DEFAULT_SPEND_LIMIT_USD = 100;

/** The hosted providers RelayRunner knows list prices for, so a spend limit can count spend. */
export const SPEND_LIMIT_PROVIDERS = HOSTED_PROVIDER_IDS.filter(hasListPrices);

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

/** What a workspace that never saved an order gets: a free local machine, then GitHub-hosted. */
export const DEFAULT_RUNNER_ORDER: RunnerOrder = {
  steps: [{ key: "machine" }, { key: "github" }],
};

/** Whether a provider's step can take a spend limit. */
export const hasSpendLimit = (key: RunnerKey) =>
  (SPEND_LIMIT_PROVIDERS as readonly string[]).includes(key);

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

/** The relay input value that hands a provider's label to the Router: `blacksmith: auto`. */
export const AUTO = "auto";

const isAutoInput = (labels: string[]) => labels.length === 1 && labels[0]?.toLowerCase() === AUTO;
const noInputs = (inputs: RelayInputs) => RUNNER_KEYS.every((key) => inputs[key].length === 0);

/**
 * Whether the Router picks the job's labels: the relay sets some provider to `auto`, or sets no
 * provider at all. A relay that names its own labels everywhere runs as written.
 */
export const isAutoRelay = (inputs: RelayInputs) =>
  noInputs(inputs) || RUNNER_KEYS.some((key) => isAutoInput(inputs[key]));

/**
 * A relay's inputs with each `auto` (every provider, when it sets none) turned into a label:
 * `machine` takes any machine, and the rest get `label(key)`, the provider's label for the job's
 * size. A provider with no label that big keeps `auto`, which the Router skips as `no_size`.
 * Labels the relay names itself stay as they are.
 */
export function resolveAutoInputs(
  inputs: RelayInputs,
  label: (key: Exclude<RunnerKey, "machine">) => string | null,
): RelayInputs {
  const all = noInputs(inputs);
  return byRunnerKey((key) => {
    if (!all && !isAutoInput(inputs[key])) return inputs[key];
    return key === "machine" ? ["self-hosted"] : [label(key) ?? AUTO];
  });
}

/** The order with `first`'s steps moved to the top, the rest as they were. */
export function preferFirst(order: RunnerOrder, first: RunnerKey | null | undefined): RunnerOrder {
  if (!first) return order;
  return {
    ...order,
    steps: [
      ...order.steps.filter((step) => step.key === first),
      ...order.steps.filter((step) => step.key !== first),
    ],
  };
}

/** Why an `auto` provider skipped a job: "GitHub-hosted has no runner with 8 vCPU or more". */
export const noSizeText = (key: RunnerKey, vcpus: number | undefined) =>
  vcpus
    ? `${RUNNER_LABELS[key]} has no runner with ${vcpus} vCPU or more`
    : `${RUNNER_LABELS[key]} has no runner that size`;
