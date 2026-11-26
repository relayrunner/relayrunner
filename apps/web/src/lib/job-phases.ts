// Where time goes inside jobs: the API sorts each step GitHub reports by its name into a setup
// item or a kind of work (apps/api/src/reports/step-phases.ts). Setup is what a job does every run
// to get the machine ready; the dashboard shows it hatched unless a cache step covers it.
import {
  CACHEABLE,
  type Part,
  type PartTimes,
  type SetupItem,
  type WorkKind,
} from "@relayrunner/api-types";

export type { Part, PartTimes, SetupItem, WorkKind };

const SETUP_LABELS = {
  runner: "Runner start and finish",
  checkout: "Checkout",
  tools: "Tools and logins",
  packages: "Packages",
  system: "System packages",
  browsers: "Browsers",
  images: "Container images",
  cache: "Cache restore and save",
} satisfies Record<SetupItem, string>;

export const SETUP_ORDER = Object.keys(SETUP_LABELS) as SetupItem[];

export const setupLabel = (item: SetupItem) => SETUP_LABELS[item];

const WORK_LABELS = { build: "Build", test: "Test", other: "Other work" } satisfies Record<
  WorkKind,
  string
>;

export const WORK_ORDER = Object.keys(WORK_LABELS) as WorkKind[];

export const workLabel = (work: WorkKind) => WORK_LABELS[work];

export const isSetup = (part: Part): part is SetupItem => part in SETUP_LABELS;

/** Whether a cache step could cover a setup item; the rest runs every time anyway. */
export const isCacheable = (item: SetupItem) => (CACHEABLE as readonly SetupItem[]).includes(item);

/** Time inside jobs, in ms: setup by item, the setup under a cache step, and work by kind. */
export type Inside = {
  setup: Partial<Record<SetupItem, number>>;
  cache: Partial<Record<SetupItem, number>>;
  work: Partial<Record<WorkKind, number>>;
};

export const emptyInside = (): Inside => ({ setup: {}, cache: {}, work: {} });

function add<K extends string>(into: Partial<Record<K, number>>, key: K, ms: number) {
  if (ms) into[key] = (into[key] ?? 0) + ms;
}

/** Adds `ms` of a part into `inside`, under the cache too when `cached`. */
function addPart(inside: Inside, part: Part, ms: number, cached: boolean) {
  if (!isSetup(part)) return add(inside.work, part, ms);
  add(inside.setup, part, ms);
  if (cached) add(inside.cache, part, ms);
}

/** Adds a job's parts into `into`; `cached` is the setup it has a cache step for. */
export function addParts(into: Inside, parts: PartTimes, cached: readonly SetupItem[]) {
  for (const [part, ms] of Object.entries(parts) as [Part, number][])
    addPart(into, part, ms, cached.includes(part as SetupItem));
  return into;
}

/** Adds `from`'s time into `into`. */
export function addInside(into: Inside, from: Inside) {
  for (const item of SETUP_ORDER) {
    add(into.setup, item, from.setup[item] ?? 0);
    add(into.cache, item, from.cache[item] ?? 0);
  }
  for (const work of WORK_ORDER) add(into.work, work, from.work[work] ?? 0);
  return into;
}

/** One run's steps, added up the same way. */
export function insideOfSteps(steps: { part: Part; ms: number; cache?: true }[]) {
  const inside = emptyInside();
  for (const step of steps) addPart(inside, step.part, step.ms, Boolean(step.cache));
  return inside;
}

const sum = (times: Partial<Record<string, number>>) =>
  Object.values(times).reduce<number>((total, ms) => total + (ms ?? 0), 0);

/** Setup time, all of it and the part under a cache step. */
export const setupTotal = (inside: Inside) => sum(inside.setup);
export const cachedTotal = (inside: Inside) => sum(inside.cache);
export const insideTotal = (inside: Inside) => sum(inside.setup) + sum(inside.work);

/** The share of step time that is setup, 0 to 1; null without step time. */
export function setupShare(inside: Inside) {
  const total = insideTotal(inside);
  return total ? setupTotal(inside) / total : null;
}
