// Repos where the user answered "no" to `connect`'s offer to set them up, so it doesn't ask
// again. Kept in <RELAYRUNNER_HOME>/declined-repos.json as a list of `owner/name` (or the
// checkout's path when it has no GitHub remote). `relayrunner init` ignores this list.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { relayrunnerHome } from "./paths.ts";

export function declinedPath(home = relayrunnerHome()) {
  return join(home, "declined-repos.json");
}

function read(path: string): string[] {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

export function isDeclined(repo: string, path = declinedPath()) {
  return read(path).includes(repo);
}

export function rememberDeclined(repo: string, path = declinedPath()) {
  const repos = read(path);
  if (repos.includes(repo)) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify([...repos, repo], null, 2)}\n`);
}
