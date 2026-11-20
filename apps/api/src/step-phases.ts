// Where time goes inside a job: each step GitHub reports, sorted by its name into a phase. GitHub
// names a `uses:` step after its action ("Run actions/cache@v4") and its post-run half "Post " plus
// that, unless the workflow names the step, so rules on names cover most steps. Anything they don't
// match is the job's own work. Steps are stored as they came (job_timing.steps), so a rule added
// here also sorts older jobs.
import type { Phase, PhaseTimes } from "@relayrunner/api-types";
import type { JobStep } from "@relayrunner/github-webhooks";
import { parseDate } from "./jobs.ts";

/** A step that ran: its name and how long it took, in whole seconds (GitHub's precision). */
export type StepTime = [name: string, seconds: number];

export type { Phase, PhaseTimes } from "@relayrunner/api-types";

const CHECKOUT = /\bactions\/checkout@|\bcheck ?out\b/i;
const CACHE = /\bcache\b|\/cache\/|sccache/i;
const DEPENDENCIES = new RegExp(
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
const SETUP =
  /\/setup-|\baction-setup\b|\bset ?up\b|\btoolchain\b|\blogin-action\b|\bdocker login\b|\binstall (node|python|go|rust|java|ruby|bun|deno|pnpm)\b/i;

/** The phase a step's time counts toward, by its name. */
export function phaseOf(name: string): Phase {
  if (name === "Set up job") return "setup";
  if (name === "Complete job") return "cleanup";
  if (name.startsWith("Post ")) {
    // A post-run step saves the cache for cache actions and the setup actions that cache;
    // everything else (checkout, logins) is tidying up.
    const action = name.slice(5);
    return CACHE.test(action) || SETUP.test(action) ? "cache" : "cleanup";
  }
  if (CHECKOUT.test(name)) return "checkout";
  if (CACHE.test(name)) return "cache";
  if (DEPENDENCIES.test(name)) return "dependencies";
  if (SETUP.test(name)) return "setup";
  return "work";
}

/**
 * The webhook's steps that took time, as stored. Skipped steps, steps without times and steps
 * under a second (most post-run steps) add nothing to a phase, so they're left out.
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

/** Adds `seconds` of a step to `into`, under its phase, in ms. */
export function addStep(into: PhaseTimes, name: string, seconds: number) {
  const phase = phaseOf(name);
  into[phase] = (into[phase] ?? 0) + seconds * 1000;
}
