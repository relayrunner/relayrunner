import { HOSTED_PROVIDER_IDS, hasListPrices, PROVIDERS } from "@relayrunner/providers";
import type { RetrySettings, RunnerOrder, RunnerStep } from "./schema.ts";

// Everything here is plain data and functions, so the dashboard can import it without Zod. The
// schemas, and the types they define, are in schema.ts.
export type { MinutesLimit, RetrySettings, RunnerOrder, RunnerStep, SpendLimit } from "./schema.ts";

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

/** What a new spend limit starts at, in dollars a month. */
export const DEFAULT_SPEND_LIMIT_USD = 100;

/** The hosted providers RelayRunner knows list prices for, so a spend limit can count spend. */
export const SPEND_LIMIT_PROVIDERS = HOSTED_PROVIDER_IDS.filter(hasListPrices);

/** What a workspace that never saved an order gets: a free local machine, then GitHub-hosted. */
export const DEFAULT_RUNNER_ORDER: RunnerOrder = {
  steps: [{ key: "machine" }, { key: "github" }],
};

/** Whether a provider's step can take a spend limit. */
export const hasSpendLimit = (key: RunnerKey) =>
  (SPEND_LIMIT_PROVIDERS as readonly string[]).includes(key);

/**
 * The providers whose free minutes a step can stop at: GitHub's included minutes, and Blacksmith's
 * free minutes (which need Blacksmith connected in Settings › Providers to count).
 */
export const MINUTES_LIMIT_PROVIDERS = ["github", "blacksmith"] as const;
export type MinutesLimitProvider = (typeof MINUTES_LIMIT_PROVIDERS)[number];

/** Whether a provider's step can take a minutes limit. */
export const hasMinutesLimit = (key: RunnerKey): key is MinutesLimitProvider =>
  (MINUTES_LIMIT_PROVIDERS as readonly string[]).includes(key);

/** Blacksmith's free minutes a month, counted in 2-vCPU minutes. */
export const BLACKSMITH_FREE_MINUTES = 3_000;

/** A step's minutes limit, if it's a provider that takes one and has one. */
export const minutesLimitOf = (step: RunnerStep) => ("limit" in step ? step.limit : undefined);

/**
 * What makes a step unique in an order: its provider, and for GitHub and Blacksmith whether it has
 * a minutes limit ("github:limit").
 */
export function stepSlot(step: RunnerStep) {
  return minutesLimitOf(step) ? `${step.key}:limit` : step.key;
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
 * Why a step skipped a public repo's job: machines never run them, and some hosted providers
 * (Boat) refuse them unless the account allows them.
 */
export const publicRepoText = (key: RunnerKey) =>
  key === "machine"
    ? "public repos never run on self-hosted machines"
    : `${RUNNER_LABELS[key]} doesn't run public repos`;

/** Why a hosted provider's step skipped a personal account's job: it only serves organizations. */
export const personalAccountText = (key: RunnerKey) =>
  `${RUNNER_LABELS[key]} only runs organizations' repos`;

/**
 * Where an automatic retry goes: `any` the same runner if it's free, else the next that fits;
 * `same` the runner that failed, first; `other` the rest of the order first, the one that failed
 * last.
 */
export const RETRY_RUNNERS = ["any", "same", "other"] as const;
export type RetryRunner = (typeof RETRY_RUNNERS)[number];

export const DEFAULT_RETRY_SETTINGS: RetrySettings = { enabled: false, runner: "any", max: 1 };

// A job id GitHub accepts under `jobs:`.
const JOB_ID = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * The relay `relayrunner init` puts in front of a job, from the name GitHub shows for it:
 * `relay-test` for `test`. Null for a name that isn't a job id: that job has a `name:` of its own,
 * so its id can't be told from the name. (`init` adds `-2` when the name is taken.)
 */
export const relayJobFor = (job: string) => (JOB_ID.test(job) ? `relay-${job}` : null);

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
