import { beforeAll, expect, test } from "vitest";
import { createDb, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import { routerSetup } from "./router-setup.ts";
import * as testing from "./testing.ts";

let env: Env;

beforeAll(async () => {
  env = await testing.createTestEnv();
});

const HOUR = 3_600_000;
let ids = 700_000;

type Timing = typeof schema.jobTiming.$inferInsert;

function job(
  installationId: number,
  runId: number,
  overrides: Partial<Timing> & { hoursAgo?: number },
) {
  ids += 1;
  const { hoursAgo = 1, ...rest } = overrides;
  const completed = Date.now() - hoursAgo * HOUR;
  return {
    id: ids,
    installationId,
    repositoryId: 1,
    repositoryFullName: "acme/app",
    runId,
    runAttempt: 1,
    workflowName: "CI",
    name: "test",
    labels: ["ubuntu-latest"],
    conclusion: "success",
    runnerName: "runner",
    startedAt: new Date(completed - 60_000),
    completedAt: new Date(completed),
    ...rest,
  } satisfies Timing;
}

test("lists workflows, routed or not, and the hosted labels jobs ran on", async () => {
  const { cookie } = await testing.signIn(env);
  const { workspace } = await testing.createWorkspace(env, cookie, "Setup", "setup");
  const installationId = 9101;
  const db = createDb(env.DB);
  await db.insert(schema.githubInstallation).values({
    id: installationId,
    accountId: installationId,
    accountLogin: "setup-org",
    accountType: "Organization",
  });
  await testing.useInstallation(env, workspace.id, installationId);

  const rows = [
    // CI: one routed run (a relay, then jobs on two Blacksmith sizes), one run before the relay.
    job(installationId, 1, { name: "relay-lint / RelayRunner", labels: ["relayrunner"] }),
    job(installationId, 1, { name: "lint", labels: ["blacksmith-2vcpu-ubuntu-2404"] }),
    job(installationId, 1, { name: "test", labels: ["blacksmith-4vcpu-ubuntu-2404"] }),
    job(installationId, 2, { name: "test", labels: ["blacksmith-4vcpu-ubuntu-2404"] }),
    // Deploy in another repo, never routed.
    job(installationId, 3, {
      repositoryId: 2,
      repositoryFullName: "acme/site",
      workflowName: "Deploy",
    }),
    // Older than the window.
    job(installationId, 4, { workflowName: "Nightly", hoursAgo: 24 * 20 }),
  ];
  await db.insert(schema.jobTiming).values(rows);

  const setup = await routerSetup(db, workspace.id);
  expect(setup.workflows).toMatchObject([
    { repository: "acme/site", workflow: "Deploy", runs: 1, routedRuns: 0 },
    { repository: "acme/app", workflow: "CI", runs: 2, routedRuns: 1 },
  ]);
  expect(setup.labels).toEqual([
    { key: "blacksmith", label: "blacksmith-4vcpu-ubuntu-2404", jobs: 2 },
    { key: "blacksmith", label: "blacksmith-2vcpu-ubuntu-2404", jobs: 1 },
  ]);
});

test("lists each workflow's jobs, with matrix legs as one, and the repos the App sees", async () => {
  const { cookie } = await testing.signIn(env);
  const { workspace } = await testing.createWorkspace(env, cookie, "Jobs", "setup-jobs");
  const installationId = 9102;
  const db = createDb(env.DB);
  await db.insert(schema.githubInstallation).values({
    id: installationId,
    accountId: installationId,
    accountLogin: "jobs-org",
    accountType: "Organization",
  });
  await testing.useInstallation(env, workspace.id, installationId);
  const seen = { installationId, githubStateAt: new Date() };
  await db.insert(schema.githubRepository).values([
    { ...seen, id: 1, fullName: "acme/app", private: true },
    { ...seen, id: 2, fullName: "acme/docs", private: false },
    { ...seen, id: 3, fullName: "acme/old", private: true, removedAt: new Date() },
  ]);
  await db.insert(schema.jobTiming).values([
    job(installationId, 1, { name: "lint" }),
    job(installationId, 1, { name: "e2e (chrome)" }),
    job(installationId, 1, {
      name: "e2e (firefox)",
      startedAt: new Date(Date.now() - HOUR - 5 * 60_000),
    }),
    job(installationId, 2, { name: "lint" }),
    job(installationId, 2, { name: "e2e (chrome)", conclusion: "failure" }),
    job(installationId, 2, { name: "deploy", conclusion: "skipped" }),
  ]);

  const setup = await routerSetup(db, workspace.id);
  expect(setup.workflows[0].jobs).toEqual([
    { name: "e2e", legs: 2, label: "ubuntu-latest", runs: 2, minutes: 5 },
    { name: "lint", legs: 1, label: "ubuntu-latest", runs: 2, minutes: 1 },
  ]);
  expect(setup.repos).toEqual([
    { id: 1, fullName: "acme/app", private: true },
    { id: 2, fullName: "acme/docs", private: false },
  ]);
  expect(setup.accessUrl).toBe(
    `https://github.com/organizations/jobs-org/settings/installations/${installationId}`,
  );
});
