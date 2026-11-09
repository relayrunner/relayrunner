// The checkout `relayrunner init` runs in: its root, its workflow files, and which GitHub repo
// `origin` points at and whether that repo is public. Nothing here needs a GitHub sign-in, so it
// works whichever account `gh` or git is signed in as.

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { WorkflowFile } from "./workflows.ts";
import { userAgent } from "./paths.ts";

export const WORKFLOWS_DIR = ".github/workflows";

/** The nearest directory at or above `from` that holds a `.git`, or null outside a checkout. */
export function findRepoRoot(from = process.cwd()) {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function readWorkflowFiles(root: string): WorkflowFile[] {
  const dir = join(root, WORKFLOWS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => ({
      file: `${WORKFLOWS_DIR}/${name}`,
      source: readFileSync(join(dir, name), "utf8"),
    }));
}

/** `owner/name` from a GitHub remote URL (https or ssh), or null for anything else. */
export function parseGitHubRemote(url: string) {
  const match =
    /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(
      url.trim(),
    );
  return match ? `${match[1]}/${match[2]}` : null;
}

export function originRepo(root: string): Promise<string | null> {
  return new Promise((done) => {
    execFile(
      "git",
      ["-C", root, "remote", "get-url", "origin"],
      { timeout: 3000, encoding: "utf8" },
      (error, stdout) => done(error ? null : parseGitHubRemote(stdout)),
    );
  });
}

export type Visibility = "public" | "private" | "unknown";

/**
 * Asks GitHub without signing in. A public repo answers; a private one (or one that doesn't exist)
 * is a 404 to an anonymous caller. Anything else, such as no network or a rate limit, is unknown.
 */
export async function repoVisibility(
  repo: string,
  fetcher: typeof fetch = fetch,
): Promise<Visibility> {
  try {
    const response = await fetcher(`https://api.github.com/repos/${repo}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": userAgent },
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 404) return "private";
    if (!response.ok) return "unknown";
    const body = (await response.json()) as { private?: boolean; visibility?: string };
    return body.private === false ? "public" : "private";
  } catch {
    return "unknown";
  }
}
