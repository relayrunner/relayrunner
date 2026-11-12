import { beforeAll, describe, expect, test } from "vitest";
import type { Env } from "./env.ts";
import * as testing from "./testing.ts";

// The #316 reset migration on data shaped like the old model: workspaces holding several
// installations (or none), unclaimed installations, and machines, members and workspace-scoped
// rows under them.
const RESET = "20261111193823_workspace_per_installation.sql";

let env: Env;

const all = async <T>(sql: string, ...binds: unknown[]) =>
  (
    await env.DB.prepare(sql)
      .bind(...binds)
      .all<T>()
  ).results;
const workspaceOf = async (installationId: number) =>
  (await env.DB.prepare("select * from workspace where installation_id = ?")
    .bind(installationId)
    .first<{
      id: string;
      name: string;
      slug: string;
      logo: string;
      runner_order: string | null;
    }>())!;

beforeAll(async () => {
  env = await testing.createTestEnv({ before: RESET });
  const now = Date.now();
  const run = (sql: string, ...binds: unknown[]) => env.DB.prepare(sql).bind(...binds);
  await env.DB.batch([
    ...["u1", "u2", "u3"].map((id) =>
      run(
        "insert into user (id, name, email, email_verified, created_at, updated_at) values (?, ?, ?, 1, ?, ?)",
        id,
        id,
        `${id}@example.com`,
        now,
        now,
      ),
    ),
    // wa holds two installs. wb holds none, and its slug is a login the reset hands out.
    run(
      `insert into workspace (id, name, slug, runner_order, created_at) values ('wa', 'Acme team', 'acme-team', '{"order":["github"]}', ?)`,
      now,
    ),
    run(
      "insert into workspace (id, name, slug, created_at) values ('wb', 'Solo', 'atticoos', ?)",
      now,
    ),
    run(
      "insert into workspace_member (id, workspace_id, user_id, role, created_at) values ('m1', 'wa', 'u1', 'owner', ?), ('m2', 'wa', 'u2', 'admin', ?), ('m3', 'wb', 'u3', 'owner', ?), ('m4', 'wb', 'u1', 'member', ?)",
      now,
      now,
      now,
      now,
    ),
    run(
      "insert into github_installation (id, workspace_id, account_id, account_login, account_type, created_at, updated_at) values (101, 'wa', 501, 'Acme', 'Organization', ?, ?), (102, 'wa', 502, 'atticoos', 'User', ?, ?), (103, null, 503, 'Loose', 'Organization', ?, ?)",
      now,
      now,
      now,
      now,
      now,
      now,
    ),
    run(
      "insert into github_repository (id, installation_id, full_name, private, github_state_at, created_at, updated_at) values (1, 101, 'Acme/app', 1, ?, ?, ?)",
      now,
      now,
      now,
    ),
    run(
      "insert into machine (id, workspace_id, name, created_by, created_at, updated_at) values ('ma', 'wa', 'laptop', 'u2', ?, ?), ('mb', 'wb', 'desktop', 'u1', ?, ?), ('mc', 'wb', 'orphan', 'u3', ?, ?)",
      now,
      now,
      now,
      now,
      now,
      now,
    ),
    run(
      "insert into machine (id, workspace_id, name, source, sharing, installation_id, github_runner_id, created_at, updated_at) values ('mg', 'wa', 'mini', 'github', 'anyone', 102, 9, ?, ?)",
      now,
      now,
    ),
    run(
      "insert into workflow_job (id, installation_id, repository_id, repository_full_name, run_id, run_attempt, kind, name, labels, head_sha, status, machine_id, github_created_at, created_at, updated_at) values (77, 101, 1, 'Acme/app', 7, 1, 'job', 'test', '[]', 'abc', 'completed', 'ma', ?, ?, ?)",
      now,
      now,
      now,
    ),
    run(
      "insert into workspace_invitation (id, workspace_id, email, expires_at, inviter_id, created_at) values ('i1', 'wa', 'x@example.com', ?, 'u1', ?)",
      now,
      now,
    ),
    run(
      "insert into activity_event (workspace_id, type, data, occurred_at) values ('wa', 'job.routed', '{}', ?)",
      now,
    ),
    run(
      "insert into route_decision (workspace_id, repository_id, run_id, run_attempt, skipped, not_in_order, machine, github, created_at) values ('wa', 1, 7, 1, '[]', '[]', '[]', '[]', ?)",
      now,
    ),
    run("insert into agent_grant (id, user_id, created_at) values ('g1', 'u1', ?)", now),
    run("insert into agent_grant_workspace (grant_id, workspace_id) values ('g1', 'wa')"),
    run(
      "insert into session (id, user_id, token, expires_at, active_workspace_id, created_at, updated_at) values ('s1', 'u1', 't1', ?, 'wa', ?, ?), ('s3', 'u3', 't3', ?, 'wb', ?, ?)",
      now + 1e6,
      now,
      now,
      now + 1e6,
      now,
      now,
    ),
  ]);
  await testing.applyMigration(env, RESET);
});

describe("reset to one workspace per installation (#316)", () => {
  test("every installation gets one workspace, named after its account", async () => {
    const acme = await workspaceOf(101);
    const personal = await workspaceOf(102);
    const loose = await workspaceOf(103);
    // The old workspace keeps its id for its lowest installation, so what's under it stays put.
    expect(acme).toMatchObject({
      id: "wa",
      name: "Acme",
      slug: "acme",
      logo: "https://avatars.githubusercontent.com/u/501?v=4",
      runner_order: null,
    });
    expect(personal).toMatchObject({ name: "atticoos", slug: "atticoos" });
    expect(loose).toMatchObject({ name: "Loose", slug: "loose" });
    expect(new Set([acme.id, personal.id, loose.id]).size).toBe(3);
    // wb had no installation, so it's gone.
    expect(await all("select id from workspace order by id")).toHaveLength(3);
  });

  test("members carry over, with their roles, into each workspace rebuilt from theirs", async () => {
    const personal = await workspaceOf(102);
    const members = (id: string) =>
      all("select user_id, role from workspace_member where workspace_id = ? order by user_id", id);
    const expected = [
      { user_id: "u1", role: "owner" },
      { user_id: "u2", role: "admin" },
    ];
    expect(await members("wa")).toEqual(expected);
    expect(await members(personal.id)).toEqual(expected);
    expect(await members((await workspaceOf(103)).id)).toEqual([]);
  });

  test("machines stay, adopted runners follow their installation, and orphans go", async () => {
    const personal = await workspaceOf(102);
    const machines = Object.fromEntries(
      (await all<{ id: string; workspace_id: string }>("select id, workspace_id from machine")).map(
        (row) => [row.id, row.workspace_id],
      ),
    );
    expect(machines.ma).toBe("wa");
    expect(machines.mg).toBe(personal.id);
    // mb's owner (u1) is in the rebuilt workspaces, so it moves into one of them.
    expect(["wa", personal.id]).toContain(machines.mb);
    // mc's owner (u3) is in none, so it went with wb.
    expect(machines.mc).toBeUndefined();
  });

  test("installations, repos and job history are kept", async () => {
    expect(await all("select id from github_installation order by id")).toEqual([
      { id: 101 },
      { id: 102 },
      { id: 103 },
    ]);
    expect(await all("select id from github_repository")).toEqual([{ id: 1 }]);
    expect(await all("select id, machine_id from workflow_job")).toEqual([
      { id: 77, machine_id: "ma" },
    ]);
  });

  test("workspace-scoped rows are dropped, and stale active workspaces cleared", async () => {
    for (const table of [
      "workspace_invitation",
      "activity_event",
      "route_decision",
      "agent_grant",
      "agent_grant_workspace",
    ])
      expect(await all(`select * from ${table}`)).toEqual([]);
    expect(await all("select id, active_workspace_id from session order by id")).toEqual([
      { id: "s1", active_workspace_id: "wa" },
      { id: "s3", active_workspace_id: null },
    ]);
  });
});
