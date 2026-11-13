import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { expect, test } from "vitest";
import skill from "../../../skills/relayrunner-ci-insights/SKILL.md?raw";
import { registerTools } from "./tools.ts";

// The relayrunner-ci-insights skill (skills/ at the repo root, installed with `npx skills add`)
// tells agents which tool answers which question. Keep its table in step with the server.
test("the ci-insights skill names every MCP tool, and only those", () => {
  const registered: string[] = [];
  const server = { registerTool: (name: string) => registered.push(name) };
  registerTools(
    server as unknown as McpServer,
    async () => {
      throw new Error("not called");
    },
    [],
  );

  const table = skill.slice(skill.indexOf("## Tools"), skill.indexOf("## Common questions"));
  const named = [...table.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((match) => match[1]);

  expect(new Set(named)).toEqual(new Set(registered));
});
