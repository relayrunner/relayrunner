import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { HOSTED_PROVIDER_IDS, LABEL_PREFIXES, RELAY_REF } from "./index.ts";

const repo = join(import.meta.dirname, "..", "..", "..");

// The skills (installed with `npx skills add relayrunner/relayrunner`), the agent guide and this
// repo's own CI show the relay version for hand-routed jobs. Keep it the one init writes.
test("the skills, agent guide and CI show the relay version init writes", () => {
  const files = [
    "docs/agent-install.md",
    ".github/workflows/ci.yml",
    ...readdirSync(join(repo, "skills"), { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".md"))
      .map((file) => join("skills", file)),
  ];
  for (const file of files) {
    const text = readFileSync(join(repo, file), "utf8");
    for (const [, version] of text.matchAll(/(?:relay\.yml@|"relay": ")(v[\w.-]+)/g))
      expect(version, file).toBe(RELAY_REF);
  }
});

test("every hosted provider has label prefixes", () => {
  expect(Object.keys(LABEL_PREFIXES).sort()).toEqual([...HOSTED_PROVIDER_IDS].sort());
});
