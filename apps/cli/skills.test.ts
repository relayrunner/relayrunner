import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { RELAY_REF } from "./workflows.ts";

// The agent skills (skills/, installed with `npx skills add relayrunner/relayrunner`) and the
// agent guide show the relay version for hand-routed jobs. Keep it the one init writes.
const repo = new URL("../../", import.meta.url);
const files = [
  "docs/agent-install.md",
  ...readdirSync(new URL("skills/", repo), { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".md"))
    .map((path) => `skills/${path}`),
];

test.each(files)("%s shows the relay version init writes", (path) => {
  const text = readFileSync(new URL(path, repo), "utf8");
  const versions = [...text.matchAll(/(?:relay\.yml@|"relay": ")(v[\w.-]+)/g)].map((m) => m[1]);
  expect(versions.filter((version) => version !== RELAY_REF)).toEqual([]);
});
