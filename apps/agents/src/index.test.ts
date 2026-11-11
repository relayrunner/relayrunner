import { describe, expect, test } from "vitest";
import worker from "./index.ts";
import type { Env } from "./env.ts";

const MCP_URL = "https://agents.relayrunner.app/mcp";

// relayrunner-api as the agent sees it: /api/me plus canned answers, recording each path asked.
// An answer can depend on the workspace the request names (x-relayrunner-workspace).
type Answer = unknown | ((workspace: string | null) => unknown);

function fakeEnv(
  answers: Record<string, Answer> = {},
  { limited = false, workspaceIds = ["w1"], names = {} as Record<string, string> } = {},
) {
  const asked: string[] = [];
  const posted: unknown[] = [];
  const env = {
    MCP_URL,
    AUTH_ISSUER: "https://app.relayrunner.app/api/auth",
    LIMITER: { limit: async () => ({ success: !limited }) },
    API: {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const headers = new Headers(init?.headers);
        const workspace = headers.get("x-relayrunner-workspace");
        const method = init?.method === "POST" ? "POST " : "";
        asked.push(method + url.pathname + url.search + (workspace ? ` @${workspace}` : ""));
        if (init?.body) posted.push(JSON.parse(String(init.body)));
        if (headers.get("authorization") !== "Bearer good") {
          return Response.json({ error: "invalid_token" }, { status: 401 });
        }
        if (url.pathname === "/api/me") {
          return Response.json({
            user: { id: "u1", name: "Ada" },
            agent: {
              grantId: "g1",
              workspaces: workspaceIds.map((id) => ({ id, name: names[id] ?? id })),
            },
          });
        }
        const found = answers[url.pathname];
        const answer = typeof found === "function" ? found(workspace) : found;
        return answer === undefined
          ? Response.json({ error: "not_found" }, { status: 404 })
          : Response.json(answer);
      },
    },
  } as unknown as Env;
  return { env, asked, posted };
}

function rpc(env: Env, body: unknown, token = "good") {
  return worker.fetch(
    new Request(MCP_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...(body as object) }),
    }),
    env,
  );
}

describe("mcp server", () => {
  test("publishes where to sign in", async () => {
    const { env } = fakeEnv();
    const response = await worker.fetch(
      new Request("https://agents.relayrunner.app/.well-known/oauth-protected-resource/mcp"),
      env,
    );
    expect(await response.json()).toMatchObject({
      resource: MCP_URL,
      authorization_servers: ["https://app.relayrunner.app/api/auth"],
    });
  });

  test("asks clients without a good token to sign in", async () => {
    const { env } = fakeEnv();
    const missing = await worker.fetch(new Request(MCP_URL, { method: "POST", body: "{}" }), env);
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://agents.relayrunner.app/.well-known/oauth-protected-resource/mcp"',
    );
    const bad = await rpc(env, { method: "tools/list" }, "bad");
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  test("lists read-only tools and answers them from the API", async () => {
    const { env, asked } = fakeEnv({
      "/api/workspaces/w1/runner-order": {
        order: { steps: [{ key: "machine" }] },
        isDefault: false,
      },
    });
    const initialized = await rpc(env, {
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    });
    expect(initialized.status).toBe(200);

    const listed = (await (await rpc(env, { method: "tools/list" })).json()) as {
      result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[] };
    };
    const names = listed.result.tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "list_workspaces",
        "get_workspace",
        "list_runners",
        "get_runner_order",
        "list_runs",
      ]),
    );
    // Every tool reads, except send_feedback, which only records a report.
    expect(
      listed.result.tools.filter((tool) => !tool.annotations.readOnlyHint).map((tool) => tool.name),
    ).toEqual(["send_feedback"]);

    const called = (await (
      await rpc(env, { method: "tools/call", params: { name: "get_runner_order", arguments: {} } })
    ).json()) as { result: { content: { text: string }[]; isError?: boolean } };
    expect(called.result.isError).toBeFalsy();
    expect(JSON.parse(called.result.content[0].text)).toMatchObject({ isDefault: false });
    expect(asked).toContain("/api/workspaces/w1/runner-order");
  });

  test("list_activity answers a few compact entries and pages past the last one", async () => {
    const walk = {
      step: "github",
      skipped: [{ key: "machine", reason: "machine_paused", paused: ["mini"] }],
      notInOrder: [],
      machine: ["macos"],
      github: ["ubuntu-latest"],
      blacksmith: [],
    };
    const items = Array.from({ length: 50 }, (_, index) => ({
      id: 100 - index,
      type: "job.routed",
      data: {},
      occurredAt: "2026-11-11T00:00:00.000Z",
      actor: null,
      machine: null,
      job: {
        id: index,
        repository: "acme/app",
        private: true,
        runId: 7,
        runAttempt: 1,
        workflow: "CI",
        name: `test ${index}`,
        runner: { type: "github", label: "ubuntu-latest" },
        walk,
        runnerName: "GitHub Actions 3",
        branch: "main",
        sha: "abc123",
        status: "completed",
        conclusion: "success",
        createdAt: "2026-11-11T00:00:00.000Z",
        startedAt: null,
        completedAt: null,
        url: "https://github.com/acme/app/actions/runs/7/job/1",
        runUrl: "https://github.com/acme/app/actions/runs/7",
        starters: { startedBy: { login: "ada", member: { id: "u1", name: "Ada" } }, rerunBy: null },
      },
    }));
    const { env } = fakeEnv({ "/api/activity": { items, nextBefore: 50 } });
    const call = async (args: object) =>
      JSON.parse(
        (
          (await (
            await rpc(env, {
              method: "tools/call",
              params: { name: "list_activity", arguments: args },
            })
          ).json()) as { result: { content: { text: string }[] } }
        ).result.content[0].text,
      );

    const compact = await call({});
    expect(compact.items).toHaveLength(15);
    expect(compact.nextBefore).toBe(86);
    expect(compact.items[0]).toEqual({
      id: 100,
      type: "job.routed",
      time: "2026-11-11T00:00:00.000Z",
      repo: "acme/app",
      workflow: "CI",
      job: "test 0",
      runId: 7,
      runner: "ubuntu-latest",
      runnerName: "GitHub Actions 3",
      status: "completed",
      conclusion: "success",
      route: {
        step: "github",
        skipped: [{ key: "machine", reason: "machine_paused", paused: ["mini"] }],
      },
      startedBy: "Ada",
    });

    const full = await call({ limit: 50, detail: true });
    expect(full.items).toHaveLength(50);
    expect(full.items[0].job.url).toContain("github.com");
    expect(full.nextBefore).toBe(50);
  });

  test("get_job_times filters workflows and leaves out times without samples", async () => {
    const stat = (samples: number) => ({ runs: samples + 1, successes: samples, samples });
    const { env } = fakeEnv({
      "/api/job-times": {
        days: 14,
        sampleCap: 30,
        baseline: "github:linux-2-core",
        environments: [
          { key: "github:linux-2-core", stat: stat(5) },
          { key: "machine:m1", stat: stat(3) },
          { key: "container", stat: stat(0) },
        ],
        workflows: [
          {
            repositoryId: 1,
            repository: "acme/app",
            workflow: "CI",
            byEnvironment: { "github:linux-2-core": stat(5), container: stat(0) },
            jobs: [
              {
                name: "test",
                byEnvironment: { "github:linux-2-core": stat(5), container: stat(0) },
              },
              { name: "flaky", byEnvironment: { container: stat(0) } },
            ],
          },
          {
            repositoryId: 2,
            repository: "acme/site",
            workflow: "Deploy",
            byEnvironment: { "machine:m1": stat(3) },
            jobs: [{ name: "build", byEnvironment: { "machine:m1": stat(3) } }],
          },
        ],
      },
    });
    const called = (await (
      await rpc(env, {
        method: "tools/call",
        params: { name: "get_job_times", arguments: { repository: "APP" } },
      })
    ).json()) as { result: { content: { text: string }[] } };
    const report = JSON.parse(called.result.content[0].text);
    expect(report.environments.map((env: { key: string }) => env.key)).toEqual([
      "github:linux-2-core",
    ]);
    expect(report.workflows).toHaveLength(1);
    expect(report.workflows[0].byEnvironment).toEqual({ "github:linux-2-core": stat(5) });
    expect(report.workflows[0].jobs.map((job: { name: string }) => job.name)).toEqual(["test"]);
  });

  test("a connection with several workspaces asks which, by id or name", async () => {
    const { env, asked } = fakeEnv(
      {
        "/api/machines": (workspace: string | null) => ({
          machines: [{ id: `m-${workspace}`, ownerImage: "x" }],
        }),
      },
      { workspaceIds: ["w1", "w2"], names: { w1: "Alpha", w2: "Beta" } },
    );
    const call = async (name: string, args: object) =>
      (
        (await (
          await rpc(env, { method: "tools/call", params: { name, arguments: args } })
        ).json()) as { result: { content: { text: string }[]; isError?: boolean } }
      ).result;

    const listed = await call("list_workspaces", {});
    expect(JSON.parse(listed.content[0].text)).toEqual({
      workspaces: [
        { id: "w1", name: "Alpha" },
        { id: "w2", name: "Beta" },
      ],
    });

    const unsaid = await call("list_runners", {});
    expect(unsaid.isError).toBe(true);
    expect(unsaid.content[0].text).toContain("list_workspaces");

    const byName = await call("list_runners", { workspace: "beta" });
    expect(JSON.parse(byName.content[0].text)).toEqual({ runners: [{ id: "m-w2" }] });
    const byId = await call("list_runners", { workspace: "w1" });
    expect(JSON.parse(byId.content[0].text)).toEqual({ runners: [{ id: "m-w1" }] });
    expect(asked).toEqual(expect.arrayContaining(["/api/machines @w2", "/api/machines @w1"]));

    const unknown = await call("list_runners", { workspace: "Gamma" });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toContain("Gamma");
  });

  test("send_feedback posts the report and doesn't repeat it back", async () => {
    const { env, asked, posted } = fakeEnv(
      { "/api/feedback": { id: "f1", redacted: 1 } },
      { workspaceIds: ["w1", "w2"] },
    );
    const report = {
      category: "bug",
      summary: "list_runs misses queued runs",
      details: "token=ghp_secret",
      tool: "list_runs",
    };
    const call = async (args: object) =>
      (await (
        await rpc(env, { method: "tools/call", params: { name: "send_feedback", arguments: args } })
      ).json()) as { result: { content: { text: string }[]; isError?: boolean } };

    // Several workspaces and none named: sent without one, not refused.
    const unscoped = await call(report);
    expect(unscoped.result.isError).toBeFalsy();
    expect(JSON.parse(unscoped.result.content[0].text)).toEqual({
      received: true,
      id: "f1",
      note: "1 secret-like value(s) were redacted before saving.",
    });
    expect(unscoped.result.content[0].text).not.toContain("ghp_");
    await call({ ...report, workspace: "w2" });
    expect(asked.filter((path) => path.startsWith("POST"))).toEqual([
      "POST /api/feedback",
      "POST /api/feedback @w2",
    ]);
    expect(posted[0]).toEqual(report);

    const invalid = await call({ category: "rant", summary: "x" });
    expect(invalid.result.isError).toBe(true);
  });

  test("an API refusal is a tool error, not a crash", async () => {
    const { env } = fakeEnv();
    const called = (await (
      await rpc(env, { method: "tools/call", params: { name: "get_workspace", arguments: {} } })
    ).json()) as { result: { content: { text: string }[]; isError: boolean } };
    expect(called.result.isError).toBe(true);
    expect(called.result.content[0].text).toContain("404");
  });

  test("rate limits per user and workspace, and only takes POST", async () => {
    const { env } = fakeEnv({}, { limited: true });
    expect((await rpc(env, { method: "tools/list" })).status).toBe(429);
    const get = await worker.fetch(new Request(MCP_URL), env);
    expect(get.status).toBe(405);
  });
});
