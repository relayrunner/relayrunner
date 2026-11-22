import {
  HOSTED_PROVIDER_IDS,
  hasListPrices,
  PROVIDERS,
  SHAPE_PLATFORM_NAMES,
  type ShapeArch,
  type ShapeOs,
  type ShapePlatform,
} from "@relayrunner/providers";
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
 * The providers whose free minutes a step can stop at: GitHub's included minutes, and the free
 * minutes of Blacksmith and Groundbox (which need the provider connected in Settings › Providers
 * to count).
 */
export const MINUTES_LIMIT_PROVIDERS = ["github", "blacksmith", "groundbox"] as const;
export type MinutesLimitProvider = (typeof MINUTES_LIMIT_PROVIDERS)[number];

/** Whether a provider's step can take a minutes limit. */
export const hasMinutesLimit = (key: RunnerKey): key is MinutesLimitProvider =>
  (MINUTES_LIMIT_PROVIDERS as readonly string[]).includes(key);

/** The hosted providers whose monthly free minutes a connection counts, for their steps' limits. */
export const FREE_MINUTES_PROVIDERS = ["blacksmith", "groundbox"] as const;
export type FreeMinutesProvider = (typeof FREE_MINUTES_PROVIDERS)[number];

export const isFreeMinutesProvider = (key: string): key is FreeMinutesProvider =>
  (FREE_MINUTES_PROVIDERS as readonly string[]).includes(key);

/** Blacksmith's free minutes a month, counted in 2-vCPU minutes. */
export const BLACKSMITH_FREE_MINUTES = 3_000;

/**
 * Each provider's free minutes a month on its free plan, shown until its connection says. Groundbox
 * reports its own count (GET /v1/account), so its number is only the Free plan's.
 */
export const FREE_MINUTES: Record<FreeMinutesProvider, number> = {
  blacksmith: BLACKSMITH_FREE_MINUTES,
  groundbox: 3_000,
};

/** A step's minutes limit, if it's a provider that takes one and has one. */
export const minutesLimitOf = (step: RunnerStep) => ("limit" in step ? step.limit : undefined);

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

/** What a relay's `os`, `arch` and `cpus` inputs ask for. Each is left out when the relay is. */
export interface RelayShape {
  os?: ShapeOs;
  arch?: ShapeArch;
  cpus?: number;
}

/** Whether a relay sets any of `os`, `arch` and `cpus`. */
export const hasShape = (shape: RelayShape | null | undefined): shape is RelayShape =>
  shape?.os !== undefined || shape?.arch !== undefined || shape?.cpus !== undefined;

/**
 * Whether the Router picks the job's labels: the relay sets `os`, `arch` or `cpus`, sets some
 * provider to `auto`, or sets no provider at all. A relay that names its own labels everywhere,
 * with no shape, runs as written.
 */
export const isAutoRelay = (inputs: RelayInputs, shape?: RelayShape | null) =>
  hasShape(shape) || noInputs(inputs) || RUNNER_KEYS.some((key) => isAutoInput(inputs[key]));

// GitHub's default self-hosted runner labels for each OS and arch.
const OS_LABELS: Record<ShapeOs, string> = { linux: "Linux", macos: "macOS", windows: "Windows" };
const ARCH_LABELS: Record<ShapeArch, string> = { x64: "X64", arm64: "ARM64" };

/**
 * The machine labels a shape asks for: its OS (Linux when it says none and `defaultOs` is set) and
 * its arch when it says one. Any arch fits a shape without one.
 */
export function shapeMachineLabels(shape: RelayShape, defaultOs: boolean): string[] {
  const os = shape.os ?? (defaultOs ? "linux" : undefined);
  return [...(os ? [OS_LABELS[os]] : []), ...(shape.arch ? [ARCH_LABELS[shape.arch]] : [])];
}

// Labels with `more` added, leaving out any already there (GitHub ignores case).
function withLabels(labels: string[], more: string[]) {
  const have = new Set(labels.map((label) => label.toLowerCase()));
  return [...labels, ...more.filter((label) => !have.has(label.toLowerCase()))];
}

/**
 * A relay's inputs with each `auto` turned into a label. A relay with a shape (`os`, `arch` or
 * `cpus`) treats every provider it doesn't name as `auto`, and so does one with no inputs at all.
 * `machine` takes any machine (one of the shape's OS and arch, with a shape), and the rest get
 * `label(key)`, the provider's label for the job's platform and size. A provider with no such label
 * keeps `auto`, which the Router skips as `no_size`. Labels the relay names itself stay as they
 * are; with a shape, a named `machine` must also have the OS and arch the shape says.
 */
export function resolveAutoInputs(
  inputs: RelayInputs,
  label: (key: Exclude<RunnerKey, "machine">) => string | null,
  shape?: RelayShape | null,
): RelayInputs {
  const shaped = hasShape(shape);
  const all = shaped || noInputs(inputs);
  return byRunnerKey((key) => {
    const given = inputs[key];
    const auto = isAutoInput(given) || (all && given.length === 0);
    if (key === "machine") {
      if (!auto)
        return shaped && given.length > 0
          ? withLabels(given, shapeMachineLabels(shape, false))
          : given;
      return ["self-hosted", ...(shaped ? shapeMachineLabels(shape, true) : [])];
    }
    return auto ? [label(key) ?? AUTO] : given;
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
export function noSizeText(key: RunnerKey, vcpus: number | undefined, platform?: ShapePlatform) {
  const runner = platform ? `${SHAPE_PLATFORM_NAMES[platform]} runner` : "runner";
  if (vcpus) return `${RUNNER_LABELS[key]} has no ${runner} with ${vcpus} vCPU or more`;
  return `${RUNNER_LABELS[key]} has no ${runner}${platform ? "" : " that size"}`;
}
