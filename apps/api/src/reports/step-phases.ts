// Where time goes inside a job: each step GitHub reports, sorted by its name into a setup item
// (what gets the machine ready every run) or the job's own work. GitHub names a `uses:` step after
// its action ("Run actions/cache@v4") and its post-run half "Post " plus that, unless the
// workflow names the step, so rules on names cover most steps. Steps are stored as they came
// (job_timing.steps), so a rule added here also sorts older jobs.
import type { JobType, Part, SetupItem } from "@relayrunner/api-types";
import type { JobStep } from "@relayrunner/github-webhooks";
import { parseDate } from "../ingest/jobs.ts";

/** A step that ran: its name and how long it took, in whole seconds (GitHub's precision). */
export type StepTime = [name: string, seconds: number];

export type { Part, PartTimes, SetupItem } from "@relayrunner/api-types";

const CHECKOUT = /\/checkout@|\bcheck ?out\b/i;
const CACHE = /\bcache\b|\/cache\/|sccache|stickydisk/i;
const BROWSERS =
  /\b(playwright|cypress) install\b|\binstall-deps\b|\bbrowsers?\b|\/setup-(chrome|firefox)\b|chromedriver/i;
const SYSTEM =
  /\bapt(-get)? (-\S+ )*install\b|\bbrew (bundle|install)\b|\bchoco install\b|\b(yum|dnf) install\b|\bapk add\b|\bsystem (packages|dependencies|deps)\b/i;
const IMAGES =
  /\bdocker (compose )?pull\b|\bpull (the )?(docker )?images?\b|^(Initialize|Stop) containers$/i;
// A provider's image builder: it pulls images and keeps their layers, so it's also a cache step.
const DOCKER_BUILDER = /setup-docker-builder/i;
const PACKAGES = new RegExp(
  [
    String.raw`\b(npm|pnpm) (ci|i|install)\b`,
    String.raw`\byarn( install)?( --\S+)*$`,
    String.raw`\bbun install\b`,
    String.raw`\bpip3? install\b`,
    String.raw`\b(poetry|pipenv|composer) install\b`,
    String.raw`\buv (sync|pip install)\b`,
    String.raw`\bbundle( install)?$`,
    String.raw`\bgo mod download\b`,
    String.raw`\bcargo fetch\b`,
    String.raw`\bdotnet restore\b`,
    String.raw`\bmix deps\.get\b`,
    String.raw`\binstall (the |all )?(dependencies|deps|packages)\b`,
  ].join("|"),
  "i",
);
const TOOLS =
  /\/setup-|\baction-setup\b|\bset ?up\b|\btoolchain\b|\blogin-action\b|\bdocker login\b|\binstall (node|python|go|rust|java|ruby|bun|deno|pnpm)\b/i;
const TEST =
  /\b(tests?|spec|specs|jest|vitest|pytest|rspec|mocha|e2e|playwright test|cypress run|go test|cargo test|swift test)\b/i;
const BUILD = /\b(build|compile|bundle|tsc|webpack|make|archive|package)\b/i;

/** The part a step's time counts toward, by its name, else by its job's type. */
export function partOf(name: string, type: JobType | null = null): Part {
  if (name === "Set up job" || name === "Complete job") return "runner";
  if (name.startsWith("Post ")) {
    // A post-run step saves the cache for cache actions and the setup actions that cache;
    // everything else (checkout, logins) is the runner tidying up.
    const action = name.slice(5);
    return CACHE.test(action) || /\/setup-/.test(action) ? "cache" : "runner";
  }
  if (CHECKOUT.test(name)) return "checkout";
  if (IMAGES.test(name) || DOCKER_BUILDER.test(name)) return "images";
  if (CACHE.test(name)) return "cache";
  if (BROWSERS.test(name)) return "browsers";
  if (SYSTEM.test(name)) return "system";
  if (PACKAGES.test(name)) return "packages";
  if (TOOLS.test(name)) return "tools";
  if (TEST.test(name)) return "test";
  if (BUILD.test(name)) return "build";
  if (type === "build") return "build";
  return type === "test" || type === "e2e" ? "test" : "other";
}

// What a cache step's name says it holds. A cache step that names none of these (a plain
// "Run actions/cache@v4") isn't tied to anything, so nothing counts as cached by it.
const CACHE_HOLDS: [SetupItem, RegExp][] = [
  [
    "packages",
    /node_modules|\b(npm|pnpm|yarn|pip|poetry|uv|cargo|rust-cache|gradle|maven|go mod|gems?|bundler?|composer|nuget|deps|dependencies|packages)\b/i,
  ],
  ["browsers", /playwright|cypress|browsers?/i],
  ["system", /\bapt\b|cache-apt-pkgs|\bbrew\b/i],
  ["images", /docker|buildx|layers?|images?/i],
];

/** What a step says a cache holds: a cache step naming it, or a setup action saving its cache. */
function cacheHolds(name: string, part: Part): SetupItem[] {
  if (SETUP_CACHE.test(name)) return ["packages"];
  if (part !== "cache" && !DOCKER_BUILDER.test(name)) return [];
  return CACHE_HOLDS.flatMap(([item, holds]) => (holds.test(name) ? [item] : []));
}
const SETUP_CACHE = /^Post Run actions\/setup-(node|python|go|java|ruby|dotnet)@/;

/** One job's steps, sorted: each name's part, and the setup items the job has a cache step for. */
export type SortedSteps = { parts: Map<string, Part>; cached: Set<SetupItem> };

/**
 * Sorts one job's step names (`type` sorting work no rule names), each name once. Only explicit
 * signs count as a cache: a cache step naming what it holds, or a setup action's post-run step
 * that saves its packages. A cache step means a cache is set up, not that it hit.
 */
export function sortSteps(names: Iterable<string>, type: JobType | null): SortedSteps {
  const parts = new Map<string, Part>();
  const cached = new Set<SetupItem>();
  for (const name of names) {
    if (parts.has(name)) continue;
    const part = partOf(name, type);
    parts.set(name, part);
    for (const item of cacheHolds(name, part)) cached.add(item);
  }
  return { parts, cached };
}

/**
 * The webhook's steps that took time, as stored. Skipped steps, steps without times and steps
 * under a second (most post-run steps) add no time, so they're left out.
 */
export function stepTimes(steps: JobStep[] | undefined): StepTime[] | null {
  if (!steps?.length) return null;
  return steps.flatMap((step): StepTime[] => {
    const started = parseDate(step.startedAt);
    const completed = parseDate(step.completedAt);
    if (step.conclusion === "skipped" || !started || !completed) return [];
    const seconds = Math.round((completed.getTime() - started.getTime()) / 1000);
    return seconds > 0 ? [[step.name, seconds]] : [];
  });
}
