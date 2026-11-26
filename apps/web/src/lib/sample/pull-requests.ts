// CI minutes per pull request for the dev preview (lib/sample/answers.ts).
import type { PullRequestMinutes, PullRequestReport } from "@/lib/pull-requests";
import { seededRandom } from "./shared";

const DAY_MS = 86_400_000;
const KEPT_DAYS = 62;

const TITLES = [
  "Add retry budget to the router",
  "Cache pnpm store between jobs",
  "Fix flaky checkout test",
  "Split e2e suite into shards",
  "Bump TypeScript to 7.1",
  "Show queue wait on provider pages",
  "Move billing poll to its own queue",
  "docs: explain runner groups",
  "Drop Node 22 from the matrix",
  "Speed up Docker layer cache",
  "Rename workspace settings tabs",
  "Add Windows build to release",
];
const REPOS = ["acme/app", "acme/api", "acme/site"];

/** Example pull requests over `from`..`to`, epoch ms. */
export function samplePullRequests(from: number, to: number): PullRequestReport {
  const start = Math.max(from, to - KEPT_DAYS * DAY_MS);
  const days = Math.max(1, Math.round((to - start) / DAY_MS));
  const random = seededRandom(days + 7);
  const count = Math.max(3, Math.round(days * 2.4));
  const pullRequests: PullRequestMinutes[] = Array.from({ length: count }, (_, i) => {
    const repository = REPOS[i % 7 === 0 ? 2 : i % 3 === 0 ? 1 : 0]!;
    const commits = 1 + Math.floor(random() ** 2 * 9);
    const perCommit = repository === "acme/site" ? 3 + random() * 4 : 12 + random() * 30;
    const minutes = Math.round(commits * perCommit * 10) / 10;
    const rerunMinutes = random() < 0.3 ? Math.round(minutes * random() * 0.4 * 10) / 10 : 0;
    const billedMinutes = Math.ceil(minutes * 1.15);
    return {
      repository,
      number: 900 - i,
      title: TITLES[i % TITLES.length]!,
      minutes,
      rerunMinutes,
      billedMinutes,
      cost: Math.round(billedMinutes * 0.006 * 1000) / 1000,
      jobs: commits * 6,
      runs: commits + (rerunMinutes ? 1 : 0),
      commits,
      lastAt: to - Math.floor(random() * (to - start)),
    };
  }).sort((a, b) => b.minutes - a.minutes);
  return {
    from: start,
    to,
    pullRequests,
    outside: REPOS.map((repository, i) => {
      const minutes = Math.round(days * (40 - i * 12));
      return {
        repository,
        minutes,
        billedMinutes: Math.ceil(minutes * 1.1),
        cost: Math.round(minutes * 1.1 * 0.006 * 1000) / 1000,
        jobs: Math.round(minutes / 3),
      };
    }),
  };
}
