import { beforeAll, describe, expect, test } from "vitest";
import { createDb, schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import * as testing from "../testing.ts";
import { DAY_MS, HOUR_MS } from "../time.ts";
import { pullRequestReport } from "./pull-request-minutes.ts";

let env: Env;

beforeAll(async () => {
  env = await testing.createTestEnv();
});

const INSTALLATION = 9100;
const REPO_ID = 91_000;
let ids = 900_000;

type Run = typeof schema.workflowRun.$inferInsert;
type Timing = typeof schema.jobTiming.$inferInsert;

// A finished run with one ubuntu-latest job per entry in `minutes`, `hoursAgo` hours back.
function run(
  minutes: number[],
  { hoursAgo = 1, runId, ...row }: Partial<Run> & { hoursAgo?: number; runId?: number } = {},
) {
  const id = runId ?? (ids += 1);
  const attempt = row.runAttempt ?? 1;
  const completed = Date.now() - hoursAgo * HOUR_MS;
  const workflowRun: Run = {
    id,
    runAttempt: attempt,
    installationId: INSTALLATION,
    repositoryId: REPO_ID,
    repositoryFullName: "acme/app",
    workflowName: "CI",
    defaultBranch: "main",
    displayTitle: "Commit message",
    event: "pull_request",
    headBranch: "feature",
    headSha: `sha-${id}`,
    status: "completed",
    conclusion: "success",
    githubUpdatedAt: new Date(completed),
    ...row,
  };
  const jobs: Timing[] = minutes.map((length) => ({
    id: (ids += 1),
    installationId: INSTALLATION,
    repositoryId: REPO_ID,
    repositoryFullName: "acme/app",
    runId: id,
    runAttempt: attempt,
    workflowName: "CI",
    name: "test",
    labels: ["ubuntu-latest"],
    conclusion: "success",
    runnerName: "runner",
    runnerGroupName: "GitHub Actions",
    startedAt: new Date(completed - length * 60_000),
    completedAt: new Date(completed),
  }));
  return { workflowRun, jobs };
}

describe("pull request minutes", () => {
  test("sums every push and re-run of a pull request, and matches branch pushes to it", async () => {
    const { cookie } = await testing.signIn(env);
    const { workspace } = await testing.createWorkspace(env, cookie, "PR minutes", "pr-minutes");
    const db = createDb(env.DB);
    await db.insert(schema.githubInstallation).values({
      id: INSTALLATION,
      accountId: INSTALLATION,
      accountLogin: "acme",
      accountType: "Organization",
    });
    await testing.useInstallation(env, workspace.id, INSTALLATION);

    const first = run([4, 6], { pullRequestNumber: 12, displayTitle: "Add login", hoursAgo: 5 });
    const runs = [
      first,
      // The same run tried again.
      run([3], {
        runId: first.workflowRun.id,
        runAttempt: 2,
        pullRequestNumber: 12,
        displayTitle: "Add login",
        hoursAgo: 4,
      }),
      // A push before the pull request opened: no number, matched by branch.
      run([2], { event: "push", hoursAgo: 6 }),
      // Another pull request.
      run([1], { pullRequestNumber: 13, headBranch: "docs", displayTitle: "Fix typo" }),
      // The default branch never counts toward a pull request.
      run([5], { event: "push", headBranch: "main" }),
      // A branch no pull request named.
      run([1.5], { event: "push", headBranch: "spike" }),
      // Before the window.
      run([9], { pullRequestNumber: 12, hoursAgo: 3 * 24 }),
    ];
    // One row a statement: D1 caps a statement's bound values.
    for (const { workflowRun, jobs } of runs) {
      await db.insert(schema.workflowRun).values(workflowRun);
      for (const job of jobs) await db.insert(schema.jobTiming).values(job);
    }

    const now = Date.now();
    const report = await pullRequestReport(db, INSTALLATION, { from: now - DAY_MS, to: now }, now);

    expect(report).toEqual({
      pullRequests: [
        {
          repository: "acme/app",
          number: 12,
          title: "Add login",
          minutes: 15,
          rerunMinutes: 3,
          cost: 0.09,
          commits: 2,
        },
        {
          repository: "acme/app",
          number: 13,
          title: "Fix typo",
          minutes: 1,
          rerunMinutes: 0,
          cost: 0.006,
          commits: 1,
        },
      ],
      outside: [{ repository: "acme/app", minutes: 6.5 }],
    });
  });
});
