import { describe, expect, test } from "vitest";
// The site publishes this at https://relayrunner.dev/openapi.json.
import { openApi } from "../../site/src/lib/openapi.ts";
import { AGENT_ROUTES_BY_METHOD, agentMayCall } from "./auth/agent-auth.ts";
import { providerRoutes } from "./routes/providers.ts";

// Each documented path with its {params} filled in, by method: "GET /api/runs/1/2/3/jobs".
const documented = Object.entries(openApi.paths).flatMap(([path, item]) =>
  Object.keys(item).map((method) => ({
    method: method.toUpperCase(),
    path: `/api${path.replace(/\{[^}]+\}/g, "1")}`,
  })),
);

describe("the published OpenAPI spec", () => {
  test("only documents routes an agent token may call", () => {
    for (const { method, path } of documented) {
      expect(agentMayCall(method, path), `${method} ${path}`).toBe(true);
    }
  });

  test("documents every route an agent token may call", () => {
    for (const [method, routes] of Object.entries(AGENT_ROUTES_BY_METHOD)) {
      if (method === "HEAD") continue;
      for (const route of routes) {
        const found = documented.some((d) => d.method === method && route.test(d.path));
        expect(found, `${method} ${route}`).toBe(true);
      }
    }
  });
});

describe("the providers routes", () => {
  // The agent route list lets through /providers/<id> by pattern, so a fixed route added under
  // /providers would be open to agents unless it's named there too.
  test("are open to agents only for the overview and a provider's reports", () => {
    const fixed = providerRoutes.routes.filter(
      (route) => route.method === "GET" && route.path !== "/" && !route.path.includes(":"),
    );
    expect(fixed.length).toBeGreaterThan(0);
    for (const { path } of fixed)
      expect(agentMayCall("GET", `/api/providers${path}`), path).toBe(false);
    expect(agentMayCall("GET", "/api/providers")).toBe(true);
    expect(agentMayCall("GET", "/api/providers/github/trends")).toBe(true);
  });
});
