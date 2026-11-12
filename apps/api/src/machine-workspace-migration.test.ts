import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Env } from "./env.ts";
import * as testing from "./testing.ts";

// The #363 migration: connected machines start in every workspace their owner is in.
const MIGRATION = "20261112031609_machine_workspace.sql";

let proxy: Awaited<ReturnType<typeof testing.startD1>>["proxy"];
let env: Env;

beforeAll(async () => {
  ({ proxy, env } = await testing.startD1({ before: MIGRATION }));
  const now = Date.now();
  const run = (sql: string, ...binds: unknown[]) => env.DB.prepare(sql).bind(...binds);
  await env.DB.batch([
    run(
      "insert into user (id, name, email, email_verified, created_at, updated_at) values ('u1', 'u1', 'u1@example.com', 1, ?, ?), ('u2', 'u2', 'u2@example.com', 1, ?, ?)",
      now,
      now,
      now,
      now,
    ),
    run(
      "insert into github_installation (id, account_id, account_login, account_type, created_at, updated_at) values (101, 501, 'Acme', 'Organization', ?, ?), (102, 502, 'u1', 'User', ?, ?)",
      now,
      now,
      now,
      now,
    ),
    run(
      "insert into workspace (id, installation_id, name, slug, created_at) values ('w1', 101, 'Acme', 'acme', ?), ('w2', 102, 'u1', 'u1', ?)",
      now,
      now,
    ),
    run(
      "insert into workspace_member (id, workspace_id, user_id, role, created_at) values ('m1', 'w1', 'u1', 'member', ?), ('m2', 'w2', 'u1', 'owner', ?), ('m3', 'w1', 'u2', 'owner', ?)",
      now,
      now,
      now,
    ),
    // u1's laptop and revoked mini, u2's studio, and an adopted runner.
    run(
      "insert into machine (id, user_id, name, token_hash, created_at, updated_at) values ('ma', 'u1', 'laptop', 'hash-a', ?, ?), ('mb', 'u2', 'studio', 'hash-b', ?, ?)",
      now,
      now,
      now,
      now,
    ),
    run(
      "insert into machine (id, user_id, name, revoked_at, created_at, updated_at) values ('mr', 'u1', 'old mini', ?, ?, ?)",
      now,
      now,
      now,
    ),
    run(
      "insert into machine (id, workspace_id, name, source, sharing, installation_id, github_runner_id, routing_label, created_at, updated_at) values ('mg', 'w1', 'runner', 'github', 'anyone', 101, 9, 'rr-runner-1', ?, ?)",
      now,
      now,
    ),
  ]);
  await testing.applyMigration(env, MIGRATION);
}, 60_000);

afterAll(async () => {
  await proxy?.dispose();
});

describe("machine workspaces (#363)", () => {
  test("each connected machine is in all of its owner's workspaces; revoked and adopted ones aren't listed", async () => {
    const { results } = await env.DB.prepare(
      "select machine_id, workspace_id from machine_workspace order by machine_id, workspace_id",
    ).all();
    expect(results).toEqual([
      { machine_id: "ma", workspace_id: "w1" },
      { machine_id: "ma", workspace_id: "w2" },
      { machine_id: "mb", workspace_id: "w1" },
    ]);
  });
});
