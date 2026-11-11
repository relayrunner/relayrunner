import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createDb, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import type { ProviderReport, ProvidersOverview } from "./provider-report.ts";
import * as testing from "./testing.ts";

let proxy: Awaited<ReturnType<typeof testing.startD1>>["proxy"];
let env: Env;

beforeAll(async () => {
  ({ proxy, env } = await testing.startD1());
}, 60_000);

afterAll(async () => {
  await proxy?.dispose();
});

let jobIds = 950_000;

type Timing = typeof schema.jobTiming.$inferInsert;

// A finished job, `seconds` long, ending an hour ago and queued 5s before it started.
function timing(installationId: number, seconds: number, job: Partial<Timing> = {}): Timing {
  jobIds += 1;
  const completed = Date.now() - 3_600_000;
  return {
    id: jobIds,
    installationId,
    repositoryId: installationId * 10,
    repositoryFullName: "acme/app",
    runId: jobIds,
    runAttempt: 1,
    workflowName: "CI",
    name: "test",
    labels: ["blacksmith-4vcpu-ubuntu-2404"],
    conclusion: "success",
    runnerName: "runner",
    runnerGroupName: "Default",
    queuedAt: new Date(completed - seconds * 1000 - 5000),
    startedAt: new Date(completed - seconds * 1000),
    completedAt: new Date(completed),
    ...job,
  };
}

async function report<T = ProviderReport>(cookie: string, path: string) {
  const res = await testing.call(env, path, cookie);
  return { status: res.status, body: (await res.json()) as T };
}

describe("provider report", () => {
  test("totals the provider's jobs and splits them by runner type", async () => {
    const { cookie: signedIn } = await testing.signIn(env);
    const { workspace, cookie } = await testing.createWorkspace(
      env,
      signedIn,
      "Providers",
      "providers",
    );
    const installationId = 8100;
    const db = createDb(env.DB);
    await db.insert(schema.githubInstallation).values({
      id: installationId,
      workspaceId: workspace.id,
      accountId: installationId,
      accountLogin: "providers-org",
      accountType: "Organization",
    });
    // A public repo: GitHub's standard runners are free there.
    await db.insert(schema.githubRepository).values({
      id: 99,
      installationId,
      fullName: "acme/oss",
      private: false,
      githubStateAt: new Date(),
    });
    const rows = [
      timing(installationId, 60),
      timing(installationId, 120),
      timing(installationId, 90, { conclusion: "failure" }),
      timing(installationId, 30, { labels: ["blacksmith-8vcpu-ubuntu-2404"] }),
      // Another provider's job, and a skipped one: neither counts.
      timing(installationId, 45, { labels: ["ubuntu-latest"], runnerGroupName: "GitHub Actions" }),
      timing(installationId, 10, { conclusion: "skipped" }),
      timing(installationId, 45, {
        labels: ["ubuntu-latest"],
        runnerGroupName: "GitHub Actions",
        repositoryId: 99,
        repositoryFullName: "acme/oss",
        workflowName: "Lint",
      }),
    ];
    for (let i = 0; i < rows.length; i += 5)
      await db.insert(schema.jobTiming).values(rows.slice(i, i + 5));

    const { status, body } = await report(cookie, "/providers/blacksmith?days=7");
    expect(status).toBe(200);
    expect(body).toMatchObject({ provider: "blacksmith", days: 7, jobs: 4, failures: 1 });
    expect(body.stat).toMatchObject({ runs: 4, successes: 3, medianMs: 60_000, waitMs: 5000 });
    // Each job rounds up to whole minutes: 1 + 2 + 2 on 4 vCPU, 1 on 8 vCPU.
    expect(body).toMatchObject({ billedMinutes: 6, cost: 0.056, unpricedJobs: 0 });
    expect(body.runners.map((r) => [r.key, r.jobs, r.failures, r.perMinute, r.cost])).toEqual([
      ["blacksmith:blacksmith-4vcpu-ubuntu-2404", 3, 1, 0.008, 0.04],
      ["blacksmith:blacksmith-8vcpu-ubuntu-2404", 1, 0, 0.016, 0.016],
    ]);
    expect(body.workflows).toEqual([{ repository: "acme/app", workflow: "CI", jobs: 4 }]);

    // The private repo's minute is billed, the public repo's is free.
    const github = await report(cookie, "/providers/github");
    expect(github.body).toMatchObject({ days: 14, jobs: 2, failures: 0, cost: 0.006 });
    expect(github.body.workflows.map((w) => w.workflow)).toEqual(["CI", "Lint"]);

    const overview = await report<ProvidersOverview>(cookie, "/providers?days=7");
    expect(overview.body.providers.map((p) => [p.provider, p.jobs, p.cost])).toEqual([
      ["blacksmith", 4, 0.056],
      ["github", 2, 0.006],
    ]);

    expect((await report(cookie, "/providers/nope")).status).toBe(404);
  });
});
