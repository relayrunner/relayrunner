import { describe, expect, test } from "vitest";
import worker from "./index.ts";
import type { Env } from "./env.ts";

const MCP_URL = "https://agents.relayrunner.app/mcp";

// relayrunner-api as the agent sees it: /api/me plus canned answers, recording each path asked.
function fakeEnv(answers: Record<string, unknown> = {}, { limited = false } = {}) {
  const asked: string[] = [];
  const env = {
    MCP_URL,
    AUTH_ISSUER: "https://app.relayrunner.app/api/auth",
    LIMITER: { limit: async () => ({ success: !limited }) },
    API: {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        asked.push(url.pathname + url.search);
        if (new Headers(init?.headers).get("authorization") !== "Bearer good") {
          return Response.json({ error: "invalid_token" }, { status: 401 });
        }
        if (url.pathname === "/api/me") {
          return Response.json({
            user: { id: "u1", name: "Ada" },
            agent: { workspaceId: "w1", scopes: ["workspace:read"], clientId: "c1" },
          });
        }
        const answer = answers[url.pathname];
        return answer === undefined
          ? Response.json({ error: "not_found" }, { status: 404 })
          : Response.json(answer);
      },
    },
  } as unknown as Env;
  return { env, asked };
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
      expect.arrayContaining(["get_workspace", "list_runners", "get_runner_order", "list_runs"]),
    );
    expect(listed.result.tools.every((tool) => tool.annotations.readOnlyHint)).toBe(true);

    const called = (await (
      await rpc(env, { method: "tools/call", params: { name: "get_runner_order", arguments: {} } })
    ).json()) as { result: { content: { text: string }[]; isError?: boolean } };
    expect(called.result.isError).toBeFalsy();
    expect(JSON.parse(called.result.content[0].text)).toMatchObject({ isDefault: false });
    expect(asked).toContain("/api/workspaces/w1/runner-order");
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
