import { branchAgent, explicitAgent, parseRunFilters, runAgent } from "@relayrunner/api-types";
import type { WebhookMessage } from "@relayrunner/github-webhooks";
import { beforeAll, describe, expect, test } from "vitest";
import { createDb, schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import { usageReport } from "../ingest/job-timings.ts";
import * as testing from "../testing.ts";
import { recentJobs } from "./job-times.ts";
import { lastDays, withPrior } from "./report-window.ts";
import { runFilterOptions } from "./run-filters.ts";
import { listRuns, performanceReport, recordWorkflowRun } from "./runs.ts";

let env: Env;

beforeAll(async () => {
  env = await testing.createTestEnv();
});

describe("agents", () => {
  test("names an agent from the account that started the run", () => {
    expect(explicitAgent(["zach", "Copilot"], null)).toBe("copilot");
    expect(explicitAgent(["devin-ai-integration[bot]"], null)).toBe("devin");
    expect(explicitAgent(["zach"], null)).toBeNull();
  });

  test("names an agent from a commit trailer", () => {
    expect(
      explicitAgent(["zach"], "fix: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>"),
    ).toBe("claude");
    expect(explicitAgent(["zach"], "feat: y\n\nCo-authored-by: Cursor Agent <a@cursor.com>")).toBe(
      "cursor",
    );
    // Mentioning one in the subject isn't a trailer.
    expect(explicitAgent(["zach"], "docs: how to use Claude")).toBeNull();
  });

  test("guesses from a branch name, but a stored agent wins", () => {
    expect(branchAgent("codex/fix-login")).toBe("codex");
    expect(branchAgent("main")).toBeNull();
    expect(runAgent(null, "claude/add-filters")).toEqual({ id: "claude", likely: true });
    expect(runAgent("copilot", "claude/add-filters")).toEqual({ id: "copilot", likely: false });
  });

  test("reads only known filters", () => {
    expect(
      parseRunFilters({ person: " ada ", agent: "nobody", trigger: "", branch: "x".repeat(300) }),
    ).toEqual({ person: "ada" });
    expect(parseRunFilters({ agent: "any", workflow: "CI" })).toEqual({
      agent: "any",
      workflow: "CI",
    });
  });
});

const HOUR = 3_600_000;
let ids = 900_000;

type RunMessage = Extract<WebhookMessage, { event: "workflow_run" }>;
type Run = Partial<RunMessage["run"]>;

async function workspaceWithRuns() {
  const { cookie } = await testing.signIn(env);
  const { workspace } = await testing.createWorkspace(env, cookie, "Filters", `filters-${ids}`);
  const installationId = 9100 + (ids % 1000);
  const db = createDb(env.DB);
  await db.insert(schema.githubInstallation).values({
    id: installationId,
    accountId: installationId,
    accountLogin: `filters-org-${ids}`,
    accountType: "Organization",
  });
  await testing.useInstallation(env, workspace.id, installationId);

  // One finished run with one 90-second job, started by `login`.
  const addRun = async (login: string, run: Run = {}) => {
    ids += 1;
    const completed = Date.now() - HOUR;
    const message: RunMessage = {
      event: "workflow_run",
      deliveryId: `d-${ids}`,
      action: "completed",
      installationId,
      receivedAt: new Date().toISOString(),
      repository: { id: installationId * 10, fullName: "acme/app" },
      run: {
        id: ids,
        runAttempt: 1,
        workflowName: "CI",
        workflowId: null,
        workflowPath: null,
        defaultBranch: "main",
        displayTitle: "a change",
        event: "pull_request",
        actorLogin: login,
        startedBy: { id: null, login },
        triggeredBy: { id: null, login },
        headBranch: "feature",
        headSha: `sha-${ids}`,
        pullRequestNumber: null,
        headCommitMessage: null,
        status: "completed",
        conclusion: "success",
        htmlUrl: null,
        runStartedAt: new Date(completed - 100_000).toISOString(),
        updatedAt: new Date(completed).toISOString(),
        ...run,
      },
    };
    await recordWorkflowRun(db, message);
    await db.insert(schema.jobTiming).values({
      id: ids,
      installationId,
      repositoryId: installationId * 10,
      repositoryFullName: "acme/app",
      runId: ids,
      runAttempt: 1,
      workflowName: message.run.workflowName,
      name: "test",
      labels: ["ubuntu-latest"],
      conclusion: "success",
      runnerName: "runner",
      runnerGroupName: "GitHub Actions",
      queuedAt: new Date(completed - 95_000),
      startedAt: new Date(completed - 90_000),
      completedAt: new Date(completed),
    });
  };

  await addRun("ada", {
    headCommitMessage: "fix: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>",
  });
  await addRun("ada", { headBranch: "codex/tidy" });
  await addRun("grace", { event: "push", headBranch: "main" });
  await addRun("dependabot[bot]", { headBranch: "dependabot/npm/vite", workflowName: "Deps" });
  return { db, workspaceId: workspace.id };
}

describe("run filters", () => {
  test("stores the agent a run's commit names", async () => {
    const { db, workspaceId } = await workspaceWithRuns();
    const report = await listRuns(db, workspaceId, lastDays(1));
    expect(report.runs.map((run) => run.agent)).toEqual(
      expect.arrayContaining([
        { id: "claude", likely: false },
        { id: "codex", likely: true },
        null,
      ]),
    );
  });

  test("narrows History, Performance and Usage the same way", async () => {
    const { db, workspaceId } = await workspaceWithRuns();
    const window = lastDays(1);
    const count = async (query: Record<string, string>) => {
      const filters = parseRunFilters(query);
      const [runs, jobs, performance, usage] = await Promise.all([
        listRuns(db, workspaceId, window, undefined, filters),
        recentJobs(db, workspaceId, window, filters),
        performanceReport(db, workspaceId, withPrior(window), filters),
        usageReport(db, workspaceId, window, filters),
      ]);
      const wallRuns = performance.workflows.reduce((sum, row) => sum + (row.wall?.runs ?? 0), 0);
      expect(jobs.jobs).toHaveLength(runs.runs.length);
      expect(wallRuns).toBe(runs.runs.length);
      expect(usage.totals.jobs).toBe(runs.runs.length);
      return runs.runs.length;
    };
    expect(await count({})).toBe(4);
    expect(await count({ person: "ada" })).toBe(2);
    expect(await count({ person: "bots" })).toBe(1);
    expect(await count({ trigger: "push" })).toBe(1);
    expect(await count({ branch: "main" })).toBe(1);
    expect(await count({ workflow: "Deps" })).toBe(1);
    expect(await count({ agent: "any" })).toBe(2);
    expect(await count({ agent: "none" })).toBe(2);
    expect(await count({ agent: "claude" })).toBe(1);
    expect(await count({ agent: "codex", person: "ada" })).toBe(1);
  });

  test("lists what each filter can be set to, busiest first", async () => {
    const { db, workspaceId } = await workspaceWithRuns();
    const options = await runFilterOptions(db, workspaceId, lastDays(1));
    expect(options.person).toEqual([
      { value: "ada", runs: 2 },
      { value: "dependabot[bot]", runs: 1 },
      { value: "grace", runs: 1 },
    ]);
    expect(options.workflow[0]).toEqual({ value: "CI", runs: 3 });
    expect(options.trigger).toEqual([
      { value: "pull_request", runs: 3 },
      { value: "push", runs: 1 },
    ]);
    expect(options.agent).toEqual([
      { value: "claude", runs: 1 },
      { value: "codex", runs: 1 },
    ]);
  });
});
