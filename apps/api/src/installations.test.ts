import { beforeAll, describe, expect, test } from "vitest";
import { createDb, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import { findInstallationAndWorkspace, installationRunnerScope } from "./installations.ts";
import * as testing from "./testing.ts";

let env: Env;

beforeAll(async () => {
  env = await testing.createTestEnv();
});

describe("installationRunnerScope", () => {
  test("reads the account type: a personal install gets a repo runner, an org an org runner", async () => {
    const db = createDb(env.DB);
    await db.insert(schema.githubInstallation).values([
      { id: 9101, accountId: 9101, accountLogin: "atticoos", accountType: "User" },
      { id: 9102, accountId: 9102, accountLogin: "relayrunner", accountType: "Organization" },
    ]);
    expect(await installationRunnerScope(db, 9101, "atticoos/side-project")).toEqual({
      kind: "repo",
      repo: "atticoos/side-project",
    });
    expect(await installationRunnerScope(db, 9102, "relayrunner/relayrunner")).toEqual({
      kind: "org",
      org: "relayrunner",
    });
  });

  test("an installation RelayRunner hasn't recorded is treated as an org", async () => {
    expect(await installationRunnerScope(createDb(env.DB), 9199, "acme/app")).toEqual({
      kind: "org",
      org: "acme",
    });
  });
});

describe("findInstallationAndWorkspace", () => {
  test("reads the installation and its workspace together, or neither", async () => {
    const db = createDb(env.DB);
    await db.insert(schema.githubInstallation).values([
      { id: 9201, accountId: 9201, accountLogin: "acme", accountType: "Organization" },
      { id: 9202, accountId: 9202, accountLogin: "nobody", accountType: "Organization" },
    ]);
    await db.insert(schema.workspace).values({
      id: "w-9201",
      installationId: 9201,
      name: "acme",
      slug: "acme-9201",
    });
    const both = await findInstallationAndWorkspace(db, 9201);
    expect(both.installation?.accountLogin).toBe("acme");
    expect(both.workspaceId).toBe("w-9201");
    const noWorkspace = await findInstallationAndWorkspace(db, 9202);
    expect(noWorkspace.installation?.accountLogin).toBe("nobody");
    expect(noWorkspace.workspaceId).toBeNull();
    expect(await findInstallationAndWorkspace(db, 9299)).toEqual({
      installation: null,
      workspaceId: null,
    });
  });
});
