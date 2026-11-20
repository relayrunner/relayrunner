import { beforeAll, expect, test, vi } from "vitest";
import { createDb, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import type { GroupAccess } from "./github-runners.ts";
import { runnerGroupCheck } from "./runner-group-check.ts";
import * as testing from "./testing.ts";

vi.mock("./github-app.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./github-app.ts")>()),
  appInstallationToken: async () => "ghs_test",
}));
const access: GroupAccess = {
  groupId: 1,
  groupName: "Default",
  visibility: "selected",
  restrictedToWorkflows: false,
  allowsPublicRepositories: false,
  repositoryIds: [301],
};
vi.mock("./github-runners.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./github-runners.ts")>()),
  fetchOneGroupAccess: async () => access,
}));

let env: Env;
beforeAll(async () => {
  env = await testing.createTestEnv();
});

test("lists the repos the Default runner group leaves out, and why", async () => {
  const { cookie } = await testing.signIn(env);
  const { workspace } = await testing.createWorkspace(env, cookie, "Groups", "groups");
  const db = createDb(env.DB);
  const now = new Date();
  await db.insert(schema.githubRepository).values(
    [
      { id: 301, fullName: "acme/in", private: true },
      { id: 302, fullName: "acme/out", private: true },
      { id: 303, fullName: "acme/open", private: false },
      { id: 304, fullName: "acme/gone", private: true, removedAt: now },
    ].map((repo) => ({ ...repo, installationId: workspace.installationId, githubStateAt: now })),
  );
  const installation = { id: workspace.installationId, login: "acme", type: "Organization" };
  expect(await runnerGroupCheck(env, db, installation)).toEqual({
    groupName: "Default",
    settingsUrl: "https://github.com/organizations/acme/settings/actions/runner-groups/1",
    blocked: [
      { repositoryId: 302, block: "not_selected" },
      { repositoryId: 303, block: "public" },
    ],
  });
  expect(await runnerGroupCheck(env, db, { ...installation, type: "User" })).toBeNull();
});
