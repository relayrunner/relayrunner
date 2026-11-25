import { AppError } from "@relayrunner/errors";
import { SKILLS_EXTENSION_ID } from "@modelcontextprotocol/server/ext/skills";
import { describe, expect, test } from "vitest";
import worker from "./index.ts";
import { serverCard } from "./server-card.ts";
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
    AUTH_ISSUER: "https://app.relayrunner.dev/api/auth",
    LIMITER: { limit: async () => ({ success: !limited }) },
    API: {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const headers = new Headers(init?.headers);
        const workspace = headers.get("x-relayrunner-workspace");
        const method = init?.method ? `${init.method} ` : "";
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
          ? Response.json(new AppError("NOT_FOUND"), { status: 404 })
          : Response.json(answer);
      },
    },
  } as unknown as Env;
  return { env, asked, posted };
}

function rpc(env: Env, body: unknown, token = "good", headers: Record<string, string> = {}) {
  return worker.fetch(
    new Request(MCP_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...(body as object) }),
    }),
    env,
  );
}

// A 2026-07-28 request: no handshake, the client's details ride along in every request's _meta.
async function modernRpc(
  env: Env,
  method: string,
  params: Record<string, unknown> = {},
  capabilities: Record<string, unknown> = {},
) {
  const response = await rpc(
    env,
    {
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": capabilities,
        },
      },
    },
    "good",
    {
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
      ...(typeof params.name === "string" && { "mcp-name": params.name }),
    },
  );
  return (await response.json()) as { result?: any; error?: { code: number } };
}

const CI_INSIGHTS = "skill://relayrunner-ci-insights/SKILL.md";

describe("mcp server", () => {
  test("publishes where to sign in", async () => {
    const { env } = fakeEnv();
    const response = await worker.fetch(
      new Request("https://agents.relayrunner.app/.well-known/oauth-protected-resource/mcp"),
      env,
    );
    expect(await response.json()).toMatchObject({
      resource: MCP_URL,
      authorization_servers: ["https://app.relayrunner.dev/api/auth"],
    });
  });

  test("publishes a server card anyone can read, without signing in", async () => {
    const { env, asked } = fakeEnv();
    const response = await worker.fetch(new Request(`${MCP_URL}/server-card`), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/mcp-server-card+json");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const card = (await response.json()) as ReturnType<typeof serverCard>;
    expect(card).toMatchObject({
      $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
      name: "app.relayrunner/mcp",
      remotes: [{ type: "streamable-http", url: MCP_URL }],
    });
    expect(card.description.length).toBeLessThanOrEqual(100);
    expect(card.remotes[0].supportedProtocolVersions).toContain("2025-06-18");
    expect(asked).toEqual([]);

    const preflight = await worker.fetch(
      new Request(`${MCP_URL}/server-card`, { method: "OPTIONS" }),
      env,
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toBe("GET");
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
    // Every tool reads, except send_feedback, which only records a report, and the ones that
    // change settings, which clients confirm first.
    expect(
      listed.result.tools.filter((tool) => !tool.annotations.readOnlyHint).map((tool) => tool.name),
    ).toEqual([
      "send_feedback",
      "set_runner_order",
      "use_workspace_order",
      "set_default_size",
      "set_job_size",
      "set_retries",
      "set_ai",
      "pause_runner",
      "resume_runner",
    ]);

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
      skipped: [
        { key: "machine", reason: "machine_paused", paused: ["mini"] },
        {
          key: "depot",
          reason: "spend_limit",
          spend: { account: "acme", spentUsd: 212.4, limitUsd: 200 },
        },
      ],
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
        repositoryId: 1,
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
        skipped: [
          { key: "machine", reason: "machine_paused", paused: ["mini"] },
          { key: "depot", reason: "spend_limit", spend: "$212/$200" },
        ],
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
    expect(report.workflows[0].jobs[0].byEnvironment).toEqual({ "github:linux-2-core": stat(5) });
    expect(report.workflows[0].jobs.map((job: { name: string }) => job.name)).toEqual(["test"]);
  });

  test("list_workflows filters by repository and get_signals asks for the breakdown only when wanted", async () => {
    const { env, asked } = fakeEnv({
      "/api/workspaces/w1/router-setup": {
        days: 14,
        workflows: [
          { repositoryId: 1, repository: "acme/app", workflow: "CI", runs: 9, routedRuns: 0 },
          { repositoryId: 2, repository: "acme/site", workflow: "Deploy", runs: 3, routedRuns: 3 },
        ],
        labels: [],
      },
      "/api/signals": {
        days: 30,
        totals: { jobs: 10, minutes: 40, cost: 0.32 },
        signals: [{ id: "short-jobs", area: "cost", count: 8, minutes: 31, cost: 0.25, rows: [] }],
        breakdown: { person: { rows: [], other: null } },
      },
    });
    const call = async (name: string, args: object) =>
      JSON.parse(
        (
          (await (
            await rpc(env, { method: "tools/call", params: { name, arguments: args } })
          ).json()) as { result: { content: { text: string }[] } }
        ).result.content[0].text,
      );

    const setup = await call("list_workflows", { repository: "APP" });
    expect(setup.workflows.map((row: { workflow: string }) => row.workflow)).toEqual(["CI"]);

    const signals = await call("get_signals", { days: 7 });
    expect(signals.signals[0].id).toBe("short-jobs");
    await call("get_signals", { breakdown: true });
    expect(asked).toContain("/api/signals?days=7&breakdown=0 @w1");
    expect(asked).toContain("/api/signals?days=30 @w1");
    await call("get_signals", { repository: "acme/app", workflow: "CI" });
    expect(asked).toContain("/api/signals?days=30&breakdown=0&repo=acme%2Fapp&workflow=CI @w1");
    await call("get_signals", { repository: "acme/app", path: "apps/web" });
    expect(asked).toContain("/api/signals?days=30&breakdown=0&repo=acme%2Fapp&path=apps%2Fweb @w1");
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

  test("the set tools send the dashboard's own requests, with only what a call sets", async () => {
    const { env, asked, posted } = fakeEnv({
      "/api/workspaces/w1/runner-order": { order: { steps: [{ key: "github" }] }, previous: {} },
      "/api/workspaces/w1/auto-jobs/7": { size: 8, first: null },
      "/api/machines": {
        machines: [
          { id: "m1", name: "Mac" },
          { id: "m2", name: "twin" },
          { id: "m3", name: "Twin" },
        ],
      },
      "/api/machines/m1/pause": { machine: { id: "m1", name: "Mac", paused: { by: "Ada" } } },
    });
    const call = async (name: string, args: object) =>
      (await (
        await rpc(env, { method: "tools/call", params: { name, arguments: args } })
      ).json()) as {
        result: { content: { text: string }[]; isError?: boolean };
      };

    await call("set_runner_order", { version: "v1", steps: [{ key: "github" }] });
    await call("set_runner_order", {
      repository: "acme/api",
      version: "v2",
      steps: [{ key: "machine" }],
    });
    await call("use_workspace_order", { repository: "acme/api" });
    await call("set_job_size", { job: 7, first: null });
    await call("set_retries", { enabled: true });
    const paused = await call("pause_runner", { runner: "mac" });
    expect(JSON.parse(paused.result.content[0].text)).toEqual({
      runner: { id: "m1", name: "Mac", paused: { by: "Ada" } },
    });
    expect(asked.filter((path) => !path.startsWith("/"))).toEqual([
      "PUT /api/workspaces/w1/runner-order",
      "PUT /api/workspaces/w1/runner-order?repo=acme%2Fapi",
      "DELETE /api/workspaces/w1/runner-order?repo=acme%2Fapi",
      "PUT /api/workspaces/w1/auto-jobs/7",
      "PUT /api/workspaces/w1/retry-settings",
      "POST /api/machines/m1/pause @w1",
    ]);
    // What a call leaves out, the API keeps.
    expect(posted.slice(0, 4)).toEqual([
      { steps: [{ key: "github" }], version: "v1" },
      { steps: [{ key: "machine" }], version: "v2" },
      { first: null },
      { enabled: true },
    ]);

    // A size the providers don't offer and a name two runners share are tool errors the model
    // can fix.
    expect((await call("set_default_size", { size: 3 })).result.isError).toBe(true);
    expect((await call("resume_runner", { runner: "twin" })).result.content[0].text).toContain(
      "More than one runner",
    );
  });

  test("changes that stop or drop something ask the person first where the client can", async () => {
    const { env, asked } = fakeEnv(
      {
        "/api/workspaces/w1/runner-order": { order: {}, previous: {} },
        "/api/workspaces/w1/ai": { offAt: "now" },
        "/api/machines": { machines: [{ id: "m1", name: "Mac" }] },
        "/api/machines/m1/pause": { machine: { id: "m1", name: "Mac", paused: {} } },
      },
      { names: { w1: "Acme" } },
    );
    const changes = () => asked.filter((path) => !path.startsWith("/"));
    const elicitation = { elicitation: {} };
    const order = {
      name: "set_runner_order",
      arguments: {
        version: "v1",
        steps: [{ key: "machine" }, { key: "github", limit: { percent: 80 } }],
      },
    };

    // A client that can't show a form gets today's behavior: the change goes through.
    await modernRpc(env, "tools/call", { name: "set_ai", arguments: { enabled: false } });
    expect(changes()).toEqual(["PUT /api/workspaces/w1/ai"]);

    // One that can is asked, and nothing changes until the person answers.
    const question = await modernRpc(env, "tools/call", order, elicitation);
    expect(question.result.resultType).toBe("input_required");
    expect(question.result.inputRequests.confirm.params.message).toBe(
      "Change the runner order in Acme to Self-hosted, then GitHub-hosted (while under 80%)? Providers left out get no jobs.",
    );
    expect(changes()).toHaveLength(1);

    const declined = await modernRpc(
      env,
      "tools/call",
      { ...order, inputResponses: { confirm: { action: "decline" } } },
      elicitation,
    );
    expect(JSON.parse(declined.result.content[0].text)).toMatchObject({ changed: false });
    expect(changes()).toHaveLength(1);

    await modernRpc(
      env,
      "tools/call",
      { ...order, inputResponses: { confirm: { action: "accept", content: {} } } },
      elicitation,
    );
    expect(changes().at(-1)).toBe("PUT /api/workspaces/w1/runner-order");

    const pause = await modernRpc(
      env,
      "tools/call",
      { name: "pause_runner", arguments: { runner: "mac" } },
      elicitation,
    );
    expect(pause.result.inputRequests.confirm.params.message).toContain("Pause Mac?");

    // Turning AI back on, or a URL-only client, doesn't ask.
    await modernRpc(
      env,
      "tools/call",
      { name: "set_ai", arguments: { enabled: true } },
      elicitation,
    );
    await modernRpc(
      env,
      "tools/call",
      { name: "set_ai", arguments: { enabled: false } },
      { elicitation: { url: {} } },
    );
    expect(changes().slice(-2)).toEqual(["PUT /api/workspaces/w1/ai", "PUT /api/workspaces/w1/ai"]);
  });

  test("an API refusal is a tool error, not a crash", async () => {
    const { env } = fakeEnv();
    const called = (await (
      await rpc(env, { method: "tools/call", params: { name: "get_workspace", arguments: {} } })
    ).json()) as { result: { content: { text: string }[]; isError: boolean } };
    expect(called.result.isError).toBe(true);
    expect(called.result.content[0].text).toBe("Not found (NOT_FOUND)");
  });

  test("serves the agent skills to 2025-era clients", async () => {
    const { env } = fakeEnv();
    const initialized = (await (
      await rpc(env, {
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      })
    ).json()) as { result: { capabilities: any; instructions: string } };
    expect(initialized.result.capabilities.extensions).toHaveProperty([SKILLS_EXTENSION_ID]);
    expect(initialized.result.instructions).toContain(CI_INSIGHTS);

    const listed = (await (await rpc(env, { method: "skills/list" })).json()) as {
      result: { skills: { uri: string; frontmatter: { name: string }; resources: unknown[] }[] };
    };
    expect(listed.result.skills.map((skill) => skill.uri)).toEqual([
      CI_INSIGHTS,
      "skill://relayrunner-route-jobs/SKILL.md",
      "skill://relayrunner/SKILL.md",
    ]);
    const routeJobs = listed.result.skills[1];
    expect(routeJobs.frontmatter.name).toBe("relayrunner-route-jobs");
    expect(routeJobs.resources).toContainEqual(
      expect.objectContaining({
        uri: "skill://relayrunner-route-jobs/references/skipped-jobs.md",
        digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      }),
    );

    const read = (await (
      await rpc(env, { method: "resources/read", params: { uri: CI_INSIGHTS } })
    ).json()) as { result: { contents: { text: string; mimeType: string }[] } };
    expect(read.result.contents[0].mimeType).toBe("text/markdown");
    expect(read.result.contents[0].text).toContain("name: relayrunner-ci-insights");

    const unknown = (await (
      await rpc(env, { method: "skills/get", params: { uri: "skill://nope/SKILL.md" } })
    ).json()) as { error: { code: number } };
    expect(unknown.error.code).toBe(-32602);
  });

  test("serves the agent skills over the 2026-07-28 revision too", async () => {
    const { env } = fakeEnv();
    const discovered = await modernRpc(env, "server/discover");
    expect(discovered.result.capabilities.extensions).toHaveProperty([SKILLS_EXTENSION_ID]);
    // The server card hardcodes the modern revision, since the SDK doesn't export it.
    const [remote] = serverCard(MCP_URL).remotes;
    expect(remote.supportedProtocolVersions).toEqual(
      expect.arrayContaining(discovered.result.supportedVersions),
    );

    const got = await modernRpc(env, "skills/get", { uri: CI_INSIGHTS });
    expect(got.result.skill.frontmatter.name).toBe("relayrunner-ci-insights");

    const tools = await modernRpc(env, "tools/list");
    expect(tools.result.tools.map((tool: { name: string }) => tool.name)).toContain("list_runs");
  });

  test("rate limits per user and workspace, and only takes POST", async () => {
    const { env } = fakeEnv({}, { limited: true });
    expect((await rpc(env, { method: "tools/list" })).status).toBe(429);
    const get = await worker.fetch(new Request(MCP_URL), env);
    expect(get.status).toBe(405);
  });
});
