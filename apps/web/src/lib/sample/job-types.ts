// CI minutes by job type for the dev preview (lib/sample/answers.ts), like GET
// /api/job-times/types.
import type { PartTimes, SetupItem } from "../job-phases.ts";
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
      ...sampleParts(type, ms * 0.8, random),
    };
  });
  jobs.sort((a, b) => b.ms - a.ms);
  return { days, start, ai: true, compare, jobs };
}

// Dev preview: a made-up split of `ms` of step time by part, the work share by type.
function sampleParts(type: JobType | null, ms: number, random: () => number) {
  const work = type === "lint" || type === "other" ? 0.35 : type === "e2e" ? 0.45 : 0.55;
  const setup = {
    runner: 0.08,
    checkout: 0.06,
    tools: 0.12,
    packages: 0.3,
    cache: 0.08,
    ...(type === "e2e" ? { browsers: 0.4, system: 0.2 } : {}),
    ...(type === "build" || type === "deploy" ? { images: 0.25 } : {}),
  };
  const rest = Object.values(setup).reduce((sum, each) => sum + each, 0);
  const parts: PartTimes = {
    [type === "build" ? "build" : type === "test" || type === "e2e" ? "test" : "other"]: Math.round(
      ms * work,
    ),
  };
  for (const [item, share] of Object.entries(setup))
    parts[item as keyof typeof setup] = Math.round(
      ((ms * (1 - work) * share) / rest) * (0.7 + random() * 0.6),
    );
  // Half the jobs cache their packages.
  const cached: SetupItem[] = random() < 0.5 ? ["packages"] : [];
  return { parts, cached };
}
