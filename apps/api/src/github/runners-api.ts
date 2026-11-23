// Self-hosted runners on GitHub: one-job (JIT) runner configs, runner state and labels, and an org's
// runner groups.

import {
  deleteIfPresent,
  getJson,
  getJsonOrNull,
  githubFetch,
  listAll,
  sendJson,
} from "./github-api.ts";

// The org's "Default" runner group. GitHub always gives it id 1.
export const DEFAULT_RUNNER_GROUP_ID = 1;

/**
 * Where a one-job runner registers. An org install registers in the org, where one runner can take
 * any of the org's repos. A personal (User) install can't have org runners, so it registers on the
 * job's own repo, which can only take that repo's jobs.
 */
export type RunnerScope = { kind: "org"; org: string } | { kind: "repo"; repo: string };

/** The scope for a job in `repo` (owner/name) under an installation of `accountType`. */
export function runnerScope(accountType: string | null | undefined, repo: string): RunnerScope {
  return accountType === "User" ? { kind: "repo", repo } : { kind: "org", org: repo.split("/")[0] };
}

const runnersPath = (scope: RunnerScope) =>
  scope.kind === "org"
    ? `/orgs/${scope.org}/actions/runners`
    : `/repos/${scope.repo}/actions/runners`;

/**
 * Register a one-job runner and return its id and encoded config. A repo runner has no runner
 * groups of its own, but GitHub still asks for one: Default (id 1) is the only one it accepts.
 */
export async function generateJitConfig(
  token: string,
  scope: RunnerScope,
  runner: { name: string; labels: string[]; runnerGroupId?: number },
) {
  const path = `${runnersPath(scope)}/generate-jitconfig`;
  // Refusals keep GitHub's status for repo-runner.ts to fall back on, so nothing is `allow`ed out.
  const response = await githubFetch(token, path, {
    method: "POST",
    allow: "any",
    body: {
      name: runner.name,
      labels: runner.labels,
      runner_group_id: (scope.kind === "org" && runner.runnerGroupId) || DEFAULT_RUNNER_GROUP_ID,
      work_folder: "_work",
    },
  });
  if (!response.ok)
    throw Object.assign(
      new Error(
        `POST ${path} failed with ${response.status}: ${(await response.text()).slice(0, 300)}`,
      ),
      { status: response.status },
    );
  const body = (await response.json()) as {
    runner: { id: number; labels?: { name: string }[] };
    encoded_jit_config: string;
  };
  return {
    runnerId: body.runner.id,
    // The labels GitHub gave the runner, which may include defaults beyond the ones we asked for.
    labels: (body.runner.labels ?? []).map((label) => label.name),
    encodedJitConfig: body.encoded_jit_config,
  };
}

/** Remove a runner that never got a job. A JIT runner that ran one removes itself. */
export async function deleteRunner(token: string, scope: RunnerScope, runnerId: number) {
  await deleteIfPresent(token, `${runnersPath(scope)}/${runnerId}`);
}

/** A runner's status as GitHub has it, or null once it's removed (404). */
async function runner(token: string, scope: RunnerScope, runnerId: number) {
  return getJsonOrNull<{ busy: boolean; status: string }>(
    token,
    `${runnersPath(scope)}/${runnerId}`,
  );
}

/** Whether a runner is busy with a job, or null once it's removed (404). */
export async function runnerBusy(token: string, scope: RunnerScope, runnerId: number) {
  return (await runner(token, scope, runnerId))?.busy ?? null;
}

/** Whether a runner is connected to GitHub now. False once it's gone (removed, or never made). */
export async function runnerOnline(token: string, scope: RunnerScope, runnerId: number) {
  return (await runner(token, scope, runnerId))?.status === "online";
}

/** A self-hosted runner registered in an org or on a repo, as GitHub lists it. */
export interface GitHubRunner {
  id: number;
  name: string;
  // "macOS", "Linux" or "Windows".
  os: string;
  status: "online" | "offline";
  busy: boolean;
  // Takes one job and is removed: a JIT runner, or a provider's autoscaled runner.
  ephemeral: boolean;
  labels: string[];
}

/** The self-hosted runners registered in an org, or on a repo. */
export async function listRunners(token: string, scope: RunnerScope): Promise<GitHubRunner[]> {
  const runners = await listAll<{
    id: number;
    name: string;
    os: string;
    status: string;
    busy: boolean;
    ephemeral?: boolean;
    labels?: { name: string }[];
  }>(token, runnersPath(scope), "runners");
  return runners.map((runner) => ({
    id: runner.id,
    name: runner.name,
    os: runner.os,
    status: runner.status === "online" ? "online" : "offline",
    busy: runner.busy,
    ephemeral: runner.ephemeral ?? false,
    labels: (runner.labels ?? []).map((label) => label.name),
  }));
}

/** Adds custom labels to a runner. GitHub keeps them on its side; the machine doesn't change. */
export async function addRunnerLabels(
  token: string,
  scope: RunnerScope,
  runnerId: number,
  labels: string[],
) {
  await sendJson(token, "POST", `${runnersPath(scope)}/${runnerId}/labels`, { labels });
}

/** Removes one custom label from a runner. A runner or label already gone is fine. */
export async function removeRunnerLabel(
  token: string,
  scope: RunnerScope,
  runnerId: number,
  label: string,
) {
  await deleteIfPresent(
    token,
    `${runnersPath(scope)}/${runnerId}/labels/${encodeURIComponent(label)}`,
  );
}

/** An org's runner group: which repos (and workflows) may use the runners in it. */
export interface RunnerGroup {
  id: number;
  name: string;
  // all: every repo; private: private (and internal) repos; selected: the group's repo list.
  visibility: "all" | "private" | "selected";
  restrictedToWorkflows: boolean;
  // Whether public repos may use the group at all, whatever its visibility. Off by default.
  allowsPublicRepositories: boolean;
}

interface RunnerGroupBody {
  id: number;
  name: string;
  visibility: string;
  restricted_to_workflows?: boolean;
  allows_public_repositories?: boolean;
}

function toRunnerGroup(group: RunnerGroupBody): RunnerGroup {
  return {
    id: group.id,
    name: group.name,
    visibility:
      group.visibility === "all" || group.visibility === "private" ? group.visibility : "selected",
    restrictedToWorkflows: group.restricted_to_workflows === true,
    allowsPublicRepositories: group.allows_public_repositories === true,
  };
}

export async function listOrgRunnerGroups(token: string, org: string): Promise<RunnerGroup[]> {
  const groups = await listAll<RunnerGroupBody>(
    token,
    `/orgs/${org}/actions/runner-groups`,
    "runner_groups",
  );
  return groups.map(toRunnerGroup);
}

/** One of an org's runner groups, such as Default (DEFAULT_RUNNER_GROUP_ID). */
export async function getOrgRunnerGroup(token: string, org: string, groupId: number) {
  return toRunnerGroup(
    await getJson<RunnerGroupBody>(token, `/orgs/${org}/actions/runner-groups/${groupId}`),
  );
}

/** The ids of the runners in a runner group. */
export async function listRunnerGroupRunnerIds(token: string, org: string, groupId: number) {
  const runners = await listAll<{ id: number }>(
    token,
    `/orgs/${org}/actions/runner-groups/${groupId}/runners`,
    "runners",
  );
  return runners.map((runner) => runner.id);
}

/** The ids of the repos a `selected` runner group lets use its runners. */
export async function listRunnerGroupRepositoryIds(token: string, org: string, groupId: number) {
  const repos = await listAll<{ id: number }>(
    token,
    `/orgs/${org}/actions/runner-groups/${groupId}/repositories`,
    "repositories",
  );
  return repos.map((repo) => repo.id);
}
