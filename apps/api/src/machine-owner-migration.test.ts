import { beforeAll, describe, expect, test } from "vitest";
import type { Env } from "./env.ts";
import * as testing from "./testing.ts";

// The #318 migration, which rebuilds the machine table so connected machines belong to their user.
const MIGRATION = "20261111211308_machine_belongs_to_user.sql";

let env: Env;

const all = async <T>(sql: string, ...binds: unknown[]) =>
  (
    await env.DB.prepare(sql)
      .bind(...binds)
      .all<T>()
  ).results;

beforeAll(async () => {
  env = await testing.createTestEnv({ before: MIGRATION });
  const now = Date.now();
  const run = (sql: string, ...binds: unknown[]) => env.DB.prepare(sql).bind(...binds);
  await env.DB.batch([
    run(
      "insert into user (id, name, email, email_verified, created_at, updated_at) values ('u1', 'u1', 'u1@example.com', 1, ?, ?)",
      now,
      now,
    ),
    run(
      "insert into github_installation (id, account_id, account_login, account_type, created_at, updated_at) values (101, 501, 'Acme', 'Organization', ?, ?)",
      now,
      now,
    ),
    run(
      "insert into workspace (id, installation_id, name, slug, created_at) values ('w1', 101, 'Acme', 'acme', ?)",
      now,
    ),
    run(
      "insert into github_repository (id, installation_id, full_name, private, github_state_at, created_at, updated_at) values (1, 101, 'Acme/app', 1, ?, ?, ?)",
      now,
      now,
      now,
    ),
    // A connected machine, one whose owner is gone, and an adopted runner.
    run(
      "insert into machine (id, workspace_id, name, created_by, token_hash, sharing, created_at, updated_at) values ('ma', 'w1', 'laptop', 'u1', 'hash-a', 'anyone', ?, ?), ('mo', 'w1', 'orphan', null, null, 'only_me', ?, ?)",
      now,
      now,
      now,
      now,
    ),
    run(
      "insert into machine (id, workspace_id, name, created_by, source, sharing, installation_id, github_runner_id, routing_label, created_at, updated_at) values ('mg', 'w1', 'mini', 'u1', 'github', 'anyone', 101, 9, 'rr-runner-1', ?, ?)",
      now,
      now,
    ),
    run(
      "insert into workflow_job (id, installation_id, repository_id, repository_full_name, run_id, run_attempt, kind, name, labels, head_sha, status, machine_id, github_created_at, created_at, updated_at) values (77, 101, 1, 'Acme/app', 7, 1, 'job', 'test', '[]', 'abc', 'completed', 'ma', ?, ?, ?), (78, 101, 1, 'Acme/app', 7, 1, 'job', 'lint', '[]', 'abc', 'completed', 'mo', ?, ?, ?)",
      now,
      now,
      now,
      now,
      now,
      now,
    ),
    run(
      "insert into activity_event (workspace_id, type, data, machine_id, occurred_at) values ('w1', 'machine.enrolled', '{}', 'mg', ?), ('w1', 'machine.connected', '{}', 'ma', ?)",
      now,
      now,
    ),
  ]);
  await testing.applyMigration(env, MIGRATION);
});

describe("machines belong to their user (#318)", () => {
  test("connected machines move to their owner, adopted runners stay with their workspace", async () => {
    expect(
      await all("select id, workspace_id, user_id, token_hash, sharing from machine order by id"),
    ).toEqual([
      { id: "ma", workspace_id: null, user_id: "u1", token_hash: "hash-a", sharing: "anyone" },
      { id: "mg", workspace_id: "w1", user_id: null, token_hash: null, sharing: "anyone" },
    ]);
  });

  test("jobs and events keep pointing at their machines; the orphan's lose it", async () => {
    expect(await all("select id, machine_id from workflow_job order by id")).toEqual([
      { id: 77, machine_id: "ma" },
      { id: 78, machine_id: null },
    ]);
    expect(await all("select type, machine_id from activity_event order by id")).toEqual([
      { type: "machine.enrolled", machine_id: "mg" },
      { type: "machine.connected", machine_id: "ma" },
    ]);
  });

  test("deleting the workspace takes its runner but not the member's machine", async () => {
    await env.DB.prepare("delete from workspace where id = 'w1'").run();
    expect(await all("select id from machine")).toEqual([{ id: "ma" }]);
    await env.DB.prepare("delete from user where id = 'u1'").run();
    expect(await all("select id from machine")).toEqual([]);
  });
});
