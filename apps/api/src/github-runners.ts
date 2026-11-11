// Self-hosted runners an org already has, added to RelayRunner as they are (#159). RelayRunner
// never talks to the machine. It reads the runner from GitHub, adds one label of its own to it
// (`rr-runner-<hex>`, kept for as long as the runner is added), and a pick that chooses the runner
// answers that label. GitHub then hands the job to the runner through its normal long poll.
//
// Every org runner sits in a runner group that decides which repos may use it. A job from a repo
// the group leaves out is never delivered and sits queued until GitHub cancels it, so routing
// checks the group's access before it picks the runner.

import {
  appInstallationToken,
  getOrgRunnerGroup,
  listOrgRunners,
  listOrgRunnerGroups,
  listRunnerGroupRepositoryIds,
  listRunnerGroupRunnerIds,
  type OrgRunner,
  type RunnerGroup,
} from "./github-app.ts";
import { hostedProviderOf } from "@relayrunner/providers";
import { routeIdFromLabels } from "./routing.ts";

export const ROUTING_LABEL_PREFIX = "rr-runner-";
// 8 lowercase hex characters. Distinct from a route's `rr-<12 hex>` label.
const ROUTING_LABEL = /^rr-runner-[0-9a-f]{8}$/;

export function newRoutingLabel() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return ROUTING_LABEL_PREFIX + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The first `rr-runner-<hex>` label, lowercased, or null. GitHub labels ignore case. */
export function routingLabelFromLabels(labels: string[]): string | null {
  for (const label of labels) {
    const lower = label.toLowerCase();
    if (ROUTING_LABEL.test(lower)) return lower;
  }
  return null;
}

/**
 * Whether a runner is one RelayRunner runs itself: a pick runner (`relayrunner`) or a one-job runner
 * minted for a connected machine (`rr-<route id>`). Those are never offered for adding.
 */
export function isOwnRunner(runner: { labels: string[] }) {
  return (
    runner.labels.some((label) => label.toLowerCase() === "relayrunner") ||
    routeIdFromLabels(runner.labels) !== null
  );
}

/**
 * Whether a runner takes one job and goes away, so it can't be added: an ephemeral runner, such as
 * one a hosted provider scales up for a job. GitHub reports some providers' scale-set runners with
 * no labels and not as ephemeral, so they're also caught by a provider's name (or label), such as
 * `blacksmith-...`.
 */
export function isEphemeralRunner(runner: {
  name?: string;
  ephemeral?: boolean;
  labels: string[];
}) {
  return (
    runner.ephemeral === true ||
    (runner.name !== undefined && hostedProviderOf(runner.name) !== null) ||
    runner.labels.some((label) => hostedProviderOf(label) !== null)
  );
}

/** Whether a runner is left out of the picker and the found-runners banner. */
export function isHiddenRunner(runner: { name?: string; ephemeral?: boolean; labels: string[] }) {
  return isOwnRunner(runner) || isEphemeralRunner(runner);
}

// GitHub reports the OS by name and the architecture only as a default label.
const OS: Record<string, "linux" | "macos" | "windows"> = {
  linux: "linux",
  macos: "macos",
  windows: "windows",
};
const ARCH: Record<string, "x64" | "arm64" | "arm"> = { x64: "x64", arm64: "arm64", arm: "arm" };

export function runnerOs(runner: { os: string }) {
  return OS[runner.os.toLowerCase()] ?? null;
}

export function runnerArch(runner: { labels: string[] }) {
  for (const label of runner.labels) {
    const arch = ARCH[label.toLowerCase()];
    if (arch) return arch;
  }
  return null;
}

/** The labels a job's `machine:` input matches: GitHub's own, without RelayRunner's routing label. */
export function matchLabels(labels: string[]) {
  return labels.filter((label) => !ROUTING_LABEL.test(label.toLowerCase()));
}

/** What a runner's group lets use it. */
export interface GroupAccess {
  groupId: number;
  groupName: string;
  visibility: "all" | "private" | "selected";
  restrictedToWorkflows: boolean;
  allowsPublicRepositories: boolean;
  // The repos a `selected` group allows; null for `all` and `private`.
  repositoryIds: number[] | null;
}

function toGroupAccess(group: RunnerGroup, repositoryIds: number[] | null): GroupAccess {
  return {
    groupId: group.id,
    groupName: group.name,
    visibility: group.visibility,
    restrictedToWorkflows: group.restrictedToWorkflows,
    allowsPublicRepositories: group.allowsPublicRepositories,
    repositoryIds,
  };
}

/**
 * Why GitHub won't deliver a repo's jobs to the group's runners, or null when it will:
 * `public` (the group doesn't allow public repos), `private_only`, or `not_selected` (missing from
 * a `selected` group's list). Workflow limits aren't checked here.
 */
export function groupBlocksRepo(access: GroupAccess, repo: { id: number; private: boolean }) {
  if (!repo.private && !access.allowsPublicRepositories) return "public" as const;
  if (!repo.private && access.visibility === "private") return "private_only" as const;
  if (access.visibility === "selected" && !access.repositoryIds?.includes(repo.id))
    return "not_selected" as const;
  return null;
}

/**
 * Whether a repo's job can be delivered to a runner in this group. Groups limited to selected
 * workflows are skipped: matching the job's workflow file isn't worth it yet. Null (the group
 * couldn't be read) allows it, so a GitHub hiccup doesn't take every runner out of routing.
 */
export function groupAllows(
  access: GroupAccess | null | undefined,
  repo: { id: number; private: boolean },
) {
  if (!access) return true;
  if (access.restrictedToWorkflows) return false;
  return groupBlocksRepo(access, repo) === null;
}

/** One runner group's access, such as Default's. The repo list is read only for `selected`. */
export async function fetchOneGroupAccess(token: string, org: string, groupId: number) {
  const group = await getOrgRunnerGroup(token, org, groupId);
  return toGroupAccess(
    group,
    group.visibility === "selected"
      ? await listRunnerGroupRepositoryIds(token, org, groupId)
      : null,
  );
}

/** "Default group · all private repos", for the dashboard. */
export function describeAccess(access: GroupAccess | null | undefined) {
  if (!access) return null;
  const repos =
    access.visibility === "selected"
      ? `${access.repositoryIds?.length ?? 0} selected ${access.repositoryIds?.length === 1 ? "repo" : "repos"}`
      : "all private repos";
  const group = access.groupName === "Default" ? "Default group" : `${access.groupName} group`;
  return access.restrictedToWorkflows
    ? `${group} · selected workflows only`
    : `${group} · ${repos}`;
}

/**
 * Each runner's group access in an org, by runner id. One call for the groups, one per group for
 * its runners (skipped when there is only one group), and one per `selected` group for its repos.
 */
export async function fetchGroupAccess(
  token: string,
  org: string,
  runners: OrgRunner[],
): Promise<Map<number, GroupAccess>> {
  const groups = await listOrgRunnerGroups(token, org);
  const access = new Map<number, GroupAccess>();
  await Promise.all(
    groups.map(async (group) => {
      const [runnerIds, repositoryIds] = await Promise.all([
        groups.length === 1
          ? runners.map((runner) => runner.id)
          : listRunnerGroupRunnerIds(token, org, group.id),
        group.visibility === "selected" ? listRunnerGroupRepositoryIds(token, org, group.id) : null,
      ]);
      for (const id of runnerIds) access.set(id, toGroupAccess(group, repositoryIds));
    }),
  );
  return access;
}

/** Why an org runner can't be added, or null when it can. */
export function cannotAdd(runner: OrgRunner, access: GroupAccess | null | undefined) {
  if (isOwnRunner(runner)) return "own";
  if (isEphemeralRunner(runner)) return "ephemeral";
  if (access?.restrictedToWorkflows) return "workflows";
  return null;
}

/**
 * An org's self-hosted runners with their group access, read fresh from GitHub. `groups: false`
 * skips the group lookups (one call per group, plus one per selected-repos group) and reads only the
 * runner list: enough to know which runners exist, not which ones a workflow-only group blocks.
 */
export async function readOrgRunners(
  env: { GITHUB_APP_ID: string; GITHUB_APP_PRIVATE_KEY: { get(): Promise<string> } },
  installationId: number,
  org: string,
  { groups = true }: { groups?: boolean } = {},
) {
  const token = await appInstallationToken(env, installationId);
  const runners = await listOrgRunners(token, org);
  const access = groups
    ? await fetchGroupAccess(token, org, runners)
    : new Map<number, GroupAccess>();
  return { token, runners, access };
}

/** A runner's labels as stored on its machine row (a JSON array), or none. */
export function parseStoredLabels(json: string | null): string[] {
  if (!json) return [];
  try {
    const labels = JSON.parse(json) as unknown;
    return Array.isArray(labels)
      ? labels.filter((label): label is string => typeof label === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * An added runner as a routing candidate for a repo's job: its live status and labels from GitHub.
 * Gone from GitHub, unreadable, or in a group that won't take the repo's job reads as offline, so
 * it's never picked: the job would sit queued.
 */
export function runnerStatus(
  runner: OrgRunner | undefined,
  access: GroupAccess | null | undefined,
  repo: { id: number; private: boolean },
): { online: boolean; state: "idle" | "busy" | null; labels?: string[] } {
  if (!runner || !groupAllows(access, repo)) return { online: false, state: null };
  return {
    labels: matchLabels(runner.labels),
    online: runner.status === "online",
    state: runner.busy ? "busy" : "idle",
  };
}
