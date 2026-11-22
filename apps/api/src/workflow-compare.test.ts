import type { PerformanceReport, WorkflowReport } from "@relayrunner/api-types";
import { beforeAll, describe, expect, test } from "vitest";
import { createDb, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import * as testing from "./testing.ts";
import { fastestRunner } from "./workflow-compare.ts";

let env: Env;

beforeAll(async () => {
  env = await testing.createTestEnv();
});

const HOUR = 3_600_000;
const NAMESPACE = ["nscloud-ubuntu-24.04-amd64-4x16"];
let workspaces = 0;
let ids = 900_000;

async function connectedWorkspace() {
  workspaces += 1;
  const { cookie: signedIn } = await testing.signIn(env);
  const { workspace, cookie } = await testing.createWorkspace(
    env,
    signedIn,
    `Compare ${workspaces}`,
    `compare-${workspaces}`,
  );
  const installationId = 9100 + workspaces;
  await createDb(env.DB)
    .insert(schema.githubInstallation)
    .values({
      id: installationId,
      accountId: installationId,
      accountLogin: `compare-org-${workspaces}`,
      accountType: "Organization",
    });
  await testing.useInstallation(env, workspace.id, installationId);
  return { cookie, installationId, workspaceId: workspace.id, repositoryId: installationId * 10 };
}

type Timing = typeof schema.jobTiming.$inferInsert;

// A run of CI: lint and test side by side, both queued 5s before they start and ending together
// `hoursAgo` hours ago, so the run takes 5s plus the longer job.
function run(
  installationId: number,
  [lint, test]: [number, number],
  { hoursAgo = 1, labels = ["ubuntu-latest"], conclusion = "success", runId = (ids += 1) } = {},
): Timing[] {
  const completed = Date.now() - hoursAgo * HOUR;
  return (
    [
      ["lint", lint],
      ["test", test],
    ] as const
  ).map(([name, seconds]) => ({
    id: (ids += 1),
    installationId,
    repositoryId: installationId * 10,
    repositoryFullName: "acme/app",
    runId,
    runAttempt: 1,
    workflowName: "CI",
    name,
    labels,
    conclusion,
    runnerName: "runner",
    runnerGroupName: labels === NAMESPACE ? "Default" : "GitHub Actions",
    queuedAt: new Date(completed - seconds * 1000 - 5000),
    startedAt: new Date(completed - seconds * 1000),
    completedAt: new Date(completed),
  }));
}

async function insert(rows: Timing[]) {
  const db = createDb(env.DB);
  for (let i = 0; i < rows.length; i += 5)
    await db.insert(schema.jobTiming).values(rows.slice(i, i + 5));
}

// Five passing runs and two failures on ubuntu-latest, five passing runs on Namespace, and one
// Namespace evaluation.
async function seed() {
  const workspace = await connectedWorkspace();
  const { installationId } = workspace;
  const rows: Timing[] = [];
  for (let i = 0; i < 5; i++) {
    rows.push(...run(installationId, [30, 90], { hoursAgo: i + 1 }));
    rows.push(...run(installationId, [20, 50], { hoursAgo: i + 1.5, labels: NAMESPACE }));
  }
  rows.push(...run(installationId, [30, 10], { conclusion: "failure", hoursAgo: 7 }));
  rows.push(...run(installationId, [30, 10], { conclusion: "failure", hoursAgo: 8 }));
  const evaluationRun = (ids += 1);
  rows.push(...run(installationId, [20, 50], { labels: NAMESPACE, runId: evaluationRun }));
  await insert(rows);
  await createDb(env.DB)
    .insert(schema.evaluation)
    .values({
      id: `eval-${evaluationRun}`,
      workspaceId: workspace.workspaceId,
      installationId,
      repositoryId: workspace.repositoryId,
      repositoryFullName: "acme/app",
      workflowPath: ".github/workflows/ci.yml",
      workflowName: "CI",
      provider: "namespace",
      vcpus: 4,
      label: NAMESPACE[0]!,
      ref: "main",
      runs: 1,
      runId: evaluationRun,
      state: "done",
    });
  return workspace;
}

describe("workflow costs on the Performance page", () => {
  test("prices runs, lists runners and finds the fastest against GitHub", async () => {
    const { cookie } = await seed();
    const res = await testing.call(env, "/job-times", cookie);
    expect(res.status).toBe(200);
    const report = (await res.json()) as PerformanceReport;
    const ci = report.workflows.find((row) => row.workflow === "CI")!;
    expect(ci.environments[0]).toBe("github:linux-2-core");
    expect(ci.environments[1]).toMatch(/^namespace:/);
    // Namespace: 55s against GitHub's 95s, from whole runs on each.
    expect(ci.fastest?.environment).toMatch(/^namespace:/);
    expect(ci.fastest?.ratio).toBeCloseTo(55 / 95);
    // GitHub: 1 + 2 billed minutes at $0.006 (private by default). Namespace: 2 minutes at $0.012.
    // Six Namespace runs against five GitHub ones puts the median on Namespace's.
    expect(ci.usd).toBeCloseTo(0.024);
    // Every run counts toward the totals, failures too.
    expect(ci.runMs).toBe(5 * 120_000 + 6 * 70_000 + 2 * 40_000);
    expect(ci.spentUsd).toBeCloseTo(5 * 0.018 + 6 * 0.024 + 2 * 2 * 0.006);
  });

  test("needs enough whole runs on GitHub and the other runner", () => {
    const runs = (environment: string | null, ms: number, n: number) =>
      Array.from({ length: n }, () => ({ environment, ms }));
    expect(fastestRunner([...runs("github:linux-2-core", 100, 5), ...runs("a:x", 50, 4)])).toBe(
      null,
    );
    expect(fastestRunner([...runs("a:x", 50, 5), ...runs(null, 10, 9)])).toBe(null);
    expect(
      fastestRunner([
        ...runs("github:linux-2-core", 100, 5),
        ...runs("a:x", 80, 5),
        ...runs("b:y", 120, 5),
      ]),
    ).toEqual({ environment: "a:x", ratio: 0.8 });
  });
});

describe("one workflow's page", () => {
  test("lists its runs and each runner's whole-run and per-job times", async () => {
    const { cookie, repositoryId } = await seed();
    const res = await testing.call(
      env,
      `/job-times/workflow?repositoryId=${repositoryId}&workflow=CI`,
      cookie,
    );
    expect(res.status).toBe(200);
    const report = (await res.json()) as WorkflowReport;
    expect(report).toMatchObject({
      repository: "acme/app",
      workflow: "CI",
      baseline: "github:linux-2-core",
      jobs: ["lint", "test"],
      truncated: false,
    });
    const [github, namespace] = report.runners;
    expect(github).toMatchObject({
      key: "github:linux-2-core",
      runs: 7,
      evaluations: 0,
      wholeRuns: 5,
      medianMs: 95_000,
      jobs: { lint: { runs: 5, medianMs: 30_000 }, test: { runs: 5, medianMs: 90_000 } },
    });
    expect(github!.usd).toBeCloseTo(0.018);
    expect(namespace).toMatchObject({ runs: 5, evaluations: 1, wholeRuns: 6, medianMs: 55_000 });
    // Successful runs only, oldest first, the evaluation's marked.
    expect(report.runs).toHaveLength(11);
    expect(report.runs.map((r) => r.at)).toEqual(report.runs.map((r) => r.at).toSorted());
    expect(report.runs.filter((r) => r.evaluation)).toHaveLength(1);
    expect(
      report.runs
        .at(-1)!
        .jobs.map((job) => job.name)
        .toSorted(),
    ).toEqual(["lint", "test"]);
    expect(report.untried).toContain("blacksmith");
    expect(report.untried).not.toContain("namespace");
  });

  test("is not found with no runs in the window, or in another workspace", async () => {
    const { repositoryId } = await seed();
    const other = await connectedWorkspace();
    const call = (cookie: string, query: string) =>
      testing.call(env, `/job-times/workflow?repositoryId=${repositoryId}${query}`, cookie);
    expect((await call(other.cookie, "&workflow=CI")).status).toBe(404);
    const { cookie } = await connectedWorkspace();
    expect((await call(cookie, "&workflow=Deploy")).status).toBe(404);
    expect((await testing.call(env, "/job-times/workflow?workflow=CI", cookie)).status).toBe(400);
  });
});
