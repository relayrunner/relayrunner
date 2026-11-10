// Why GitHub will never hand a repo's relay job to the pick runner. When GitHub refuses a pick
// runner on the job's repo (src/repo-runner.ts), it falls back to the org's Default runner group
// (DEFAULT_RUNNER_GROUP_ID), and GitHub only delivers a job to a
// runner whose group lets the job's repo use it (groupBlocksRepo). A job from a repo the group
// leaves out is never offered: it sits queued until GitHub's 24-hour limit ends it, with no error
// on the run. So the pick checks the group first and, when it would never get the job, says why.

import type { GroupAccess, groupBlocksRepo } from "./github-runners.ts";

type Block = NonNullable<ReturnType<typeof groupBlocksRepo>>;

/** The reason, with the fix, for Activity and the check run. */
export function blockedReason(block: Block, access: GroupAccess, repo: string) {
  const group = `the org's ${access.groupName} runner group`;
  const [cause, fix] = {
    public: [`${group} doesn't allow public repositories`, `turn on "Allow public repositories"`],
    private_only: [`${group} only allows private repositories`, "change Repository access"],
    not_selected: [`${repo} isn't in ${group}`, `add ${repo} to Repository access`],
  }[block];
  return `${cause}, so GitHub never offers ${repo}'s relay job to RelayRunner. An org owner can ${fix} under Settings → Actions → Runner groups → ${access.groupName}.`;
}

/** The failed check run that puts the reason on the commit, next to the stuck run. */
export function pickAccessCheckRun(headSha: string, runUrl: string, reason: string) {
  return {
    name: "RelayRunner",
    headSha,
    conclusion: "failure" as const,
    title: "RelayRunner can't pick a runner for this repository",
    summary: `The relay job in [this run](${runUrl}) will stay queued: ${reason}\n\nOnce the repository is allowed, cancel the run and re-run it. GitHub can take up to half an hour to apply a runner group change.`,
  };
}
