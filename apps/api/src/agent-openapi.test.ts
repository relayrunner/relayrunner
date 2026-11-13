import { describe, expect, test } from "vitest";
// The site publishes this at https://relayrunner.app/openapi.json.
import { openApi } from "../../site/src/lib/openapi.ts";
import { AGENT_ROUTES_BY_METHOD, agentMayCall } from "./agent-auth.ts";

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
