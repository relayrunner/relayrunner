/**
 * Whether a workflow's relay was taken off the repo's default branch, checked before the operator
 * ping says a workspace took the relay out (stickiness.ts). Stickiness reads only runs, so a relay
 * that was only ever tried on PR branches can look removed once newer branches, cut from a default
 * branch that never had it, run without it. The workflow file on the default branch settles it.
 */
import { getJson } from "../github/github-api.ts";
import { repoFile } from "../github/repos-api.ts";
import { RELAYRUNNER_LABEL } from "./labels.ts";

/**
 * - present: the default branch's file still has the relay, so the runs without it are something
 *   else (a gated job, a branch that never had it).
 * - removed: the default branch had it at the last relay and doesn't now, or the file is gone.
 * - never_merged: the default branch didn't have it at the last relay either: still a trial.
 */
export type RelayOnDefault = "present" | "removed" | "never_merged";

const RELAY = new RegExp(
  String.raw`relayrunner/actions/\.github/workflows/relay\.yml|runs-on:\s*\[?\s*["']?${RELAYRUNNER_LABEL}(?![\w-])`,
  "i",
);

/** Whether a workflow file routes through the relay: it calls relay.yml or runs on the label. */
export function hasRelay(text: string | null) {
  return text !== null && RELAY.test(text);
}

export async function relayOnDefaultBranch(
  token: string,
  repo: string,
  path: string,
  lastRelayAt: Date,
): Promise<RelayOnDefault> {
  if (hasRelay(await repoFile(token, repo, path))) return "present";
  // The file as the default branch had it at the last relay: its last commit up to then.
  const query = new URLSearchParams({ path, until: lastRelayAt.toISOString(), per_page: "1" });
  const [commit] = await getJson<{ sha: string }[]>(token, `/repos/${repo}/commits?${query}`);
  if (!commit) return "never_merged";
  return hasRelay(await repoFile(token, repo, path, commit.sha)) ? "removed" : "never_merged";
}
