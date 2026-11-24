// A repo on GitHub: check runs, pull request files, its contents, and who can read or push to it.

import {
  getJson,
  GitHubAccessError,
  githubFetch,
  listAll,
  MAX_LISTED,
  sendJson,
} from "./github-api.ts";

/**
 * Post a finished check run on a commit, as the App. A check with the same name on the same
 * commit replaces the earlier one on the pull request. Returns the check run's page on GitHub.
 */
export async function createCheckRun(
  token: string,
  repo: string,
  check: {
    name: string;
    headSha: string;
    conclusion: "success" | "failure";
    title: string;
    summary: string;
    // Our own id for the check, to find it again with checkRunsNamed.
    externalId?: string;
  },
) {
  const body = await sendJson<{ html_url?: string | null }>(
    token,
    "POST",
    `/repos/${repo}/check-runs`,
    {
      name: check.name,
      head_sha: check.headSha,
      status: "completed",
      conclusion: check.conclusion,
      output: { title: check.title, summary: check.summary },
      ...(check.externalId ? { external_id: check.externalId } : {}),
    },
  );
  return { url: body.html_url ?? null };
}

/** The latest check runs with this name on a commit. */
export async function checkRunsNamed(token: string, repo: string, sha: string, name: string) {
  const query = new URLSearchParams({ check_name: name, filter: "latest", per_page: "100" });
  const body = await getJson<{
    check_runs: { id: number; conclusion: string | null; external_id: string | null }[];
  }>(token, `/repos/${repo}/commits/${sha}/check-runs?${query}`);
  return body.check_runs;
}

// A check run's result. GitHub takes at most 50 annotations per request.
export interface CheckRunOutput {
  conclusion: "success" | "failure" | "neutral" | "skipped";
  title: string;
  summary: string;
  annotations?: {
    path: string;
    start_line: number;
    end_line: number;
    start_column?: number;
    end_column?: number;
    annotation_level: "notice" | "warning" | "failure";
    title?: string;
    message: string;
  }[];
}

/** Open an in-progress check run on a commit, to finish later with completeCheckRun. */
export async function startCheckRun(token: string, repo: string, name: string, headSha: string) {
  const body = await sendJson<{ id: number }>(token, "POST", `/repos/${repo}/check-runs`, {
    name,
    head_sha: headSha,
    status: "in_progress",
  });
  return body.id;
}

/** Finish a check run that startCheckRun opened. Returns its page on GitHub. */
export async function completeCheckRun(
  token: string,
  repo: string,
  checkRunId: number,
  { conclusion, ...output }: CheckRunOutput,
) {
  const body = await sendJson<{ html_url?: string | null }>(
    token,
    "PATCH",
    `/repos/${repo}/check-runs/${checkRunId}`,
    { status: "completed", conclusion, output },
  );
  return { url: body.html_url ?? null };
}

// A file a pull request touches, as GET /repos/{repo}/pulls/{n}/files lists it. GitHub leaves
// `patch` out for a binary file or a diff too large to show.
export interface PullRequestFile {
  filename: string;
  status: string;
  changes: number;
  patch?: string;
}

/**
 * The files a pull request touches, or null when it touches more than listAll reads (GitHub lists
 * at most 3,000 anyway), so the caller can treat it as touching everything. `cache` as in listAll.
 */
export async function pullRequestFiles(
  token: string,
  repo: string,
  pullRequest: number,
  { cache = true } = {},
) {
  const files = await listAll<PullRequestFile>(
    token,
    `/repos/${repo}/pulls/${pullRequest}/files`,
    undefined,
    { cache },
  );
  return files.length >= MAX_LISTED ? null : files;
}

/**
 * The repo's files at a commit, as a gzipped tarball with one top-level directory. GitHub
 * redirects to a short-lived codeload URL, which fetch follows.
 */
export async function repoTarball(token: string, repo: string, sha: string) {
  const path = `/repos/${repo}/tarball/${sha}`;
  const response = await githubFetch(token, path);
  if (!response.body) throw new Error(`GET ${path} had no body`);
  return response.body;
}

/** A file's text from the repo's default branch, or null when it doesn't exist. */
export async function repoFile(token: string, repo: string, path: string): Promise<string | null> {
  const response = await githubFetch(token, `/repos/${repo}/contents/${path}`, {
    accept: "application/vnd.github.raw+json",
    allow: [404],
  });
  return response.status === 404 ? null : response.text();
}

/** The repo's default branch (Metadata read). */
export async function repoDefaultBranch(token: string, repo: string): Promise<string> {
  const body = await getJson<{ default_branch?: string }>(token, `/repos/${repo}`);
  if (!body.default_branch) throw new Error(`GET /repos/${repo} had no default_branch`);
  return body.default_branch;
}

/**
 * A GitHub user's permission on a repo, by account id: "admin", "write", "read" or "none" (GitHub
 * reports maintain as write and triage as read). GitHub answers 404 for a user it doesn't know or
 * who has no access, which reads as "none".
 */
async function userRepoPermission(token: string, repo: string, userId: number) {
  try {
    const { login } = await getJson<{ login: string }>(token, `/user/${userId}`);
    const { permission } = await getJson<{ permission?: string }>(
      token,
      `/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`,
    );
    return permission ?? "none";
  } catch (error) {
    if (error instanceof GitHubAccessError && error.status === 404) return "none";
    throw error;
  }
}

/** Whether a GitHub user, by account id, can read a repo: any permission but `none`. */
export async function userCanReadRepo(token: string, repo: string, userId: number) {
  return (await userRepoPermission(token, repo, userId)) !== "none";
}

/** Whether a GitHub user, by account id, can push to a repo, and so edit its workflow files. */
export async function userCanWriteRepo(token: string, repo: string, userId: number) {
  const permission = await userRepoPermission(token, repo, userId);
  return permission === "write" || permission === "admin";
}
