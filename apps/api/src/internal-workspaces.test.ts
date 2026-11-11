import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createDb } from "./db/index.ts";
import type { Env } from "./env.ts";
import { internalWorkspaceIds, isInternalWorkspace } from "./internal-workspaces.ts";
import * as testing from "./testing.ts";

let proxy: Awaited<ReturnType<typeof testing.startD1>>["proxy"];
let env: Env;

beforeAll(async () => {
  const started = await testing.startD1();
  proxy = started.proxy;
  env = started.env;
}, 60_000);

afterAll(async () => {
  await proxy?.dispose();
});

async function operator() {
  const signedIn = await testing.signIn(env);
  await env.DB.prepare("update user set role = 'operator' where id = ?")
    .bind(signedIn.user.id)
    .run();
  return signedIn;
}

// A workspace whose members haven't synced yet, installed by a GitHub account.
async function memberless(slug: string, installerGithubId: number) {
  const signedIn = await testing.signIn(env);
  const { workspace } = await testing.createWorkspace(env, signedIn.cookie, slug, slug);
  await env.DB.batch([
    env.DB.prepare("delete from workspace_member where workspace_id = ?").bind(workspace.id),
    env.DB.prepare("update github_installation set installer_github_id = ? where id = ?").bind(
      installerGithubId,
      workspace.installationId,
    ),
  ]);
  return workspace.id;
}

describe("internal workspaces", () => {
  test("ours when every member is an operator, or nobody synced yet and an operator installed it", async () => {
    const op = await operator();
    const ours = (await testing.createWorkspace(env, op.cookie, "Ours", "ours-internal")).workspace;
    const customer = await testing.signIn(env);
    const theirs = (await testing.createWorkspace(env, customer.cookie, "Acme", "acme-internal"))
      .workspace;
    // An operator invited into a customer's org doesn't hide it.
    const shared = (await testing.createWorkspace(env, customer.cookie, "Both", "both-internal"))
      .workspace;
    await env.DB.prepare(
      "insert into workspace_member (id, workspace_id, user_id, role, created_at) values (?, ?, ?, 'member', ?)",
    )
      .bind(crypto.randomUUID(), shared.id, op.user.id, Date.now())
      .run();
    const installedByUs = await memberless("fresh-ours", op.githubId);
    const installedByThem = await memberless("fresh-theirs", customer.githubId);

    const db = createDb(env.DB);
    const ids = await internalWorkspaceIds(db);
    const expected = {
      [ours.id]: true,
      [theirs.id]: false,
      [shared.id]: false,
      [installedByUs]: true,
      [installedByThem]: false,
    };
    for (const [id, internal] of Object.entries(expected)) {
      expect([id, ids.has(id)]).toEqual([id, internal]);
      expect([id, await isInternalWorkspace(db, id)]).toEqual([id, internal]);
    }
  });
});
