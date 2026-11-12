// Repos where the user answered "no" to `connect`'s offer to set them up, so it doesn't ask
// again. Kept in <RELAYRUNNER_HOME>/declined-repos.json as a list of `owner/name` (or the
// checkout's path when it has no GitHub remote). `relayrunner init` ignores this list.

import { join } from "node:path";
import { readList, writeList } from "./list-file.ts";
import { relayrunnerHome } from "./paths.ts";

export function declinedPath(home = relayrunnerHome()) {
  return join(home, "declined-repos.json");
}

export function isDeclined(repo: string, path = declinedPath()) {
  return readList(path).includes(repo);
}

export function rememberDeclined(repo: string, path = declinedPath()) {
  const repos = readList(path);
  if (!repos.includes(repo)) writeList(path, [...repos, repo]);
}
