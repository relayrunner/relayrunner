// Fails when a changeset names any package other than the two that are released: the CLI (npm)
// and the Mac app (apps/mac/scripts/release.sh). `changeset version` throws on a name that isn't in
// the workspace, and versioning a package nobody releases is a mistake, so either would surprise
// someone after merge. This catches it in the PR instead.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const RELEASED = ["relayrunner", "@relayrunner/mac"];
const dir = join(import.meta.dirname, "..", ".changeset");

const problems = [];
for (const file of readdirSync(dir)) {
  if (!file.endsWith(".md") || file.toLowerCase() === "readme.md") continue;
  const text = readFileSync(join(dir, file), "utf8");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!frontmatter) {
    problems.push(`${file}: no frontmatter`);
    continue;
  }
  for (const line of frontmatter[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^\s*["']?([^"':]+)["']?\s*:\s*(major|minor|patch)\s*$/.exec(line);
    if (!match) problems.push(`${file}: can't read "${line.trim()}"`);
    else if (!RELEASED.includes(match[1])) {
      problems.push(
        `${file}: names "${match[1]}", but only ${RELEASED.map((n) => `"${n}"`).join(" and ")} are released`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error(`changeset-lint:\n${problems.map((p) => `  ${p}`).join("\n")}`);
  process.exit(1);
}
