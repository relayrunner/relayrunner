import type { McpServer } from "@modelcontextprotocol/server";
import { expect, test } from "vitest";
import { SKILL_FILES } from "./skills.ts";
import { toolContext } from "./context.ts";
import { registerTools } from "./tools.ts";
import { registerWriteTools } from "./write-tools.ts";

const skill = SKILL_FILES["relayrunner-ci-insights/SKILL.md"];

// The relayrunner-ci-insights skill (skills/ at the repo root, installed with `npx skills add`)
// tells agents which tool answers which question. Keep its table in step with the server.
test("the ci-insights skill names every MCP tool, and only those", () => {
  const registered: string[] = [];
  const server = { registerTool: (name: string) => registered.push(name) };
  const notCalled = async () => {
    throw new Error("not called");
  };
  const context = toolContext(notCalled, []);
  registerTools(server as unknown as McpServer, context);
  registerWriteTools(server as unknown as McpServer, context);

  const table = skill.slice(skill.indexOf("## Tools"), skill.indexOf("## Common questions"));
  const named = [...table.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((match) => match[1]);

  expect(new Set(named)).toEqual(new Set(registered));
});
