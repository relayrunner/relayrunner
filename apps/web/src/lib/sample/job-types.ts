// CI minutes by job type for the dev preview (lib/sample/answers.ts), like GET
// /api/job-times/types.
import type { PhaseTimes } from "../job-phases.ts";
import { DAY_MS, type JobType } from "../job-times.ts";
import { hasTrend } from "./shared.ts";
import { startOfDay } from "../time-zone.ts";
import type { JobTypeTimes } from "../job-types.ts";
import { seededRandom } from "./shared.ts";

/** Dev preview: a made-up report for `VITE_AUTH_DISABLED=true` builds, which have no API. */
export function sampleJobTypeTimes(days: number): JobTypeTimes {
  const random = seededRandom(11);
  const start = startOfDay(Date.now(), 1 - days);
  const compare = hasTrend(days);
  // [repo, workflow, job, type, runs a day, minutes a run]
  const specs: [string, string, string, JobType | null, number, number][] = [
    ["acme/app", "CI", "test", "test", 24, 6.5],
    ["acme/api", "CI", "integration", "test", 12, 8],
    ["acme/app", "CI", "unit", "test", 30, 1.5],
    ["acme/app", "CI", "build", "build", 26, 3.2],
    ["acme/api", "Docker", "image", "build", 6, 7],
    ["acme/app", "CI", "lint", "lint", 40, 0.6],
    ["acme/api", "CI", "typecheck", "lint", 18, 0.9],
    ["acme/app", "E2E", "playwright", "e2e", 8, 11],
    ["acme/app", "Release", "publish", "deploy", 3, 4],
    ["acme/api", "Deploy", "deploy", "deploy", 4, 3],
    ["acme/app", "Labeler", "label", "other", 20, 0.3],
    ["acme/api", "Nightly", "benchmarks", null, 1, 14],
  ];
  const jobs = specs.map(([repository, workflow, job, type, perDay, minutes]) => {
    const byDay = Array.from({ length: days }, (_, i) => {
      const weekday = new Date(start + i * DAY_MS).getUTCDay();
      const busy = weekday === 0 || weekday === 6 ? 0.25 : 1;
      return Math.round(perDay * busy * (0.6 + random() * 0.8) * minutes * 60_000);
    });
    const ms = byDay.reduce((sum, each) => sum + each, 0);
    const runs = Math.round(ms / (minutes * 60_000));
    return {
      repository,
      workflow,
      job,
      type,
      runs,
      ms,
      priorMs: compare ? Math.round(ms * (0.75 + random() * 0.5)) : null,
      byDay,
      stepped: Math.round(runs * 0.8),
      phases: samplePhases(type, ms * 0.8, random),
    };
  });
  jobs.sort((a, b) => b.ms - a.ms);
  return { days, start, ai: true, compare, jobs };
}

// Dev preview: a made-up split of `ms` of step time, the shares by type.
function samplePhases(type: JobType | null, ms: number, random: () => number): PhaseTimes {
  const work = type === "lint" || type === "other" ? 0.35 : type === "e2e" ? 0.7 : 0.55;
  const shares = { setup: 0.12, checkout: 0.05, dependencies: 0.15, cache: 0.08, cleanup: 0.02 };
  const rest = Object.values(shares).reduce((sum, each) => sum + each, 0);
  const phases: PhaseTimes = { work: Math.round(ms * work) };
  for (const [phase, share] of Object.entries(shares))
    phases[phase as keyof typeof shares] = Math.round(
      ((ms * (1 - work) * share) / rest) * (0.7 + random() * 0.6),
    );
  return phases;
}
