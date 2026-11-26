import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { createDb, type Db } from "../db/index.ts";
import * as testing from "../testing.ts";
import {
  clearNoRouteChecks,
  hadUnroutableAttempt,
  noRouteCheckRun,
  ROUTE_CHECK_NAME,
} from "./route-check.ts";

afterEach(() => vi.unstubAllGlobals());

const run = { repo: "acme/app", headSha: "abc", runId: 7, runAttempt: 2 };

describe("noRouteCheckRun", () => {
  test("titles the check with the reason's first clause and links the fix", () => {
    const check = noRouteCheckRun(
      run,
      "No runner available: acme has used 3,153 of its 3,000 free Blacksmith minutes (105%), past the 90% limit; `github` isn't set on this relay.",
      { name: "Usage", url: "https://app.example/usage" },
    );
    expect(check).toMatchObject({
      name: ROUTE_CHECK_NAME,
      headSha: "abc",
      conclusion: "failure",
      title: "acme has used 3,153 of its 3,000 free Blacksmith minutes (105%), past the 90% limit",
      externalId: "7:2",
    });
    expect(check.summary).toContain("https://github.com/acme/app/actions/runs/7");
    expect(check.summary).toContain("[Open Usage](https://app.example/usage)");
  });

  test("cuts a long title short", () => {
    const check = noRouteCheckRun(run, `No runner available: ${"x".repeat(300)}.`);
    expect(check.title).toHaveLength(120);
    expect(check.title.endsWith("…")).toBe(true);
  });
});

describe("clearNoRouteChecks", () => {
  function stubFetch(checks: { id: number; conclusion: string; external_id: string | null }[]) {
    const calls: { url: string; method: string; body: string }[] = [];
    vi.stubGlobal("fetch", async (input: URL | string, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, method: init.method ?? "GET", body: String(init.body ?? "") });
      return Response.json(init.method === "PATCH" ? {} : { check_runs: checks });
    });
    return calls;
  }

  test("turns green only this run's failures from earlier attempts", async () => {
    const calls = stubFetch([
      { id: 1, conclusion: "failure", external_id: "7:1" },
      { id: 2, conclusion: "failure", external_id: "8:1" },
      { id: 3, conclusion: "failure", external_id: "7:2" },
      { id: 4, conclusion: "success", external_id: "7:1" },
      { id: 5, conclusion: "failure", external_id: null },
    ]);
    await clearNoRouteChecks("token", run);
    const patches = calls.filter((call) => call.method === "PATCH");
    expect(patches.map((call) => call.url.split("/").pop())).toEqual(["1"]);
    expect(JSON.parse(patches[0].body)).toMatchObject({ conclusion: "success" });
  });
});

describe("hadUnroutableAttempt", () => {
  let db: Db;

  beforeAll(async () => {
    const env = await testing.createTestEnv();
    db = createDb(env.DB);
    const now = Date.now();
    const statements = [
      "insert into github_installation (id, account_id, account_login, account_type, created_at, updated_at) values (9, 12, 'route-org', 'Organization', ?1, ?1)",
      "insert into workspace (id, installation_id, name, slug, created_at) values ('w9', 9, 'W9', 'w9', ?1)",
      // Run 30's first attempt couldn't route; run 31's first attempt routed.
      `insert into route_decision (workspace_id, repository_id, run_id, run_attempt, step, runner, skipped, not_in_order, machine, github, hosted, reason, created_at) values ('w9', 1, 30, 1, null, null, '[]', '[]', '[]', '[]', '{}', 'No runner available: x.', ?1)`,
      `insert into route_decision (workspace_id, repository_id, run_id, run_attempt, step, runner, skipped, not_in_order, machine, github, hosted, created_at) values ('w9', 1, 31, 1, 'github', 'ubuntu-latest', '[]', '[]', '[]', '[]', '{}', ?1)`,
    ];
    for (const sql of statements) await env.DB.prepare(sql).bind(now).run();
  });

  test("is true only for a re-run after an attempt that couldn't route", async () => {
    expect(await hadUnroutableAttempt(db, { repositoryId: 1, runId: 30, runAttempt: 2 })).toBe(
      true,
    );
    expect(await hadUnroutableAttempt(db, { repositoryId: 1, runId: 30, runAttempt: 1 })).toBe(
      false,
    );
    expect(await hadUnroutableAttempt(db, { repositoryId: 1, runId: 31, runAttempt: 2 })).toBe(
      false,
    );
  });
});
