import { beforeAll, expect, test } from "vitest";
import { createDb, type Db } from "./db/index.ts";
import { earlierPick } from "./route-decisions.ts";
import * as testing from "./testing.ts";

let db: Db;

beforeAll(async () => {
  const env = await testing.createTestEnv();
  db = createDb(env.DB);
  const now = Date.now();
  const statements = [
    "insert into github_installation (id, account_id, account_login, account_type, created_at, updated_at) values (8, 11, 'rerun-org', 'Organization', ?1, ?1)",
    "insert into workspace (id, installation_id, name, slug, created_at) values ('w2', 8, 'W2', 'w2', ?1)",
    // Attempt 1 picked a macOS machine; attempt 3 (a full re-run) picked another route.
    `insert into route_decision (workspace_id, repository_id, run_id, run_attempt, step, runner, skipped, not_in_order, machine, github, hosted, started_by_id, started_by_login, triggered_by_id, triggered_by_login, created_at) values ('w2', 1, 9, 1, 'machine', 'rr-0123456789ab', '[]', '[]', '["macOS"]', '["macos-latest"]', '{}', 5, 'ada', 5, 'ada', ?1)`,
    `insert into route_decision (workspace_id, repository_id, run_id, run_attempt, step, runner, skipped, not_in_order, machine, github, hosted, created_at) values ('w2', 1, 9, 3, 'machine', 'rr-ffffffffffff', '[]', '[]', '["Linux"]', '[]', '{}', ?1)`,
  ];
  for (const sql of statements) await env.DB.prepare(sql).bind(now).run();
});

test("finds the earlier attempt's pick that answered a re-run job's label", async () => {
  const pick = await earlierPick(db, {
    repositoryId: 1,
    runId: 9,
    runAttempt: 2,
    label: "rr-0123456789ab",
  });
  expect(pick).toMatchObject({
    runAttempt: 1,
    inputs: { machine: ["macOS"], github: ["macos-latest"] },
    startedBy: { id: 5, login: "ada" },
    triggeredBy: { id: 5, login: "ada" },
  });
});

test("never a label no earlier pick of the run answered", async () => {
  const key = { repositoryId: 1, runId: 9 };
  // Another run, a later attempt's pick, the job's own attempt, and a label nobody answered.
  expect(
    await earlierPick(db, { ...key, runId: 10, runAttempt: 2, label: "rr-0123456789ab" }),
  ).toBeNull();
  expect(await earlierPick(db, { ...key, runAttempt: 2, label: "rr-ffffffffffff" })).toBeNull();
  expect(await earlierPick(db, { ...key, runAttempt: 1, label: "rr-0123456789ab" })).toBeNull();
  expect(await earlierPick(db, { ...key, runAttempt: 2, label: "rr-aaaaaaaaaaaa" })).toBeNull();
});
