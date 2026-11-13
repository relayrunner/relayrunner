import { expect, test } from "vitest";
import { SKILL_FILES } from "./skills.ts";

const onDisk = import.meta.glob(["../../../skills/**/*", "!**/README.md"], {
  query: "?raw",
  import: "default",
  eager: true,
});

// skills.ts imports each file by name, so a file added to skills/ needs a line there too.
test("the MCP server serves every file in skills/", () => {
  const files = Object.fromEntries(
    Object.entries(onDisk).map(([path, text]) => [path.replace("../../../skills/", ""), text]),
  );
  expect(SKILL_FILES).toEqual(files);
});
