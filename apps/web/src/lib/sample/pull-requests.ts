// CI minutes per pull request for the dev preview (lib/sample/answers.ts).
import type { PullRequestMinutes, PullRequestReport } from "@/lib/pull-requests";
import { DAY_MS } from "@/lib/job-times";
import { seededRandom } from "./shared";

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

/** Example pull requests over a window, epoch ms. */
export function samplePullRequests({ from, to }: { from: number; to: number }): PullRequestReport {
  const days = Math.max(1, Math.round((to - from) / DAY_MS));
  const random = seededRandom(days + 7);
  const count = Math.max(3, Math.round(days * 2.4));
  const pullRequests: PullRequestMinutes[] = Array.from({ length: count }, (_, i) => {
    const repository = REPOS[i % 7 === 0 ? 2 : i % 3 === 0 ? 1 : 0]!;
    const commits = 1 + Math.floor(random() ** 2 * 9);
    const perCommit = repository === "acme/site" ? 3 + random() * 4 : 12 + random() * 30;
    const minutes = tenths(commits * perCommit);
    return {
      repository,
      number: 900 - i,
      title: TITLES[i % TITLES.length]!,
      minutes,
      rerunMinutes: random() < 0.3 ? tenths(minutes * random() * 0.4) : 0,
      cost: Math.round(Math.ceil(minutes * 1.15) * 6) / 1000,
      commits,
    };
  }).sort((a, b) => b.minutes - a.minutes);
  return {
    pullRequests,
    outside: REPOS.map((repository, i) => ({ repository, minutes: days * (40 - i * 12) })),
  };
}

const tenths = (value: number) => Math.round(value * 10) / 10;
