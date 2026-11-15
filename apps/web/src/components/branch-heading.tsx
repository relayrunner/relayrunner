import { GitBranchIcon, GitPullRequestIcon } from "lucide-react";
import type { BranchGroup } from "@/lib/branch-groups";
import { pullRequestUrl } from "@/lib/runs";

/** A group of jobs' heading: its pull request when a run came from one, else its branch. */
export function BranchHeading({ group }: { group: BranchGroup<unknown> }) {
  const pr = group.pullRequest;
  if (!pr)
    return (
      <span className="inline-flex max-w-full items-center gap-1.5">
        <GitBranchIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">{group.branch}</span>
      </span>
    );
  return (
    <a
      href={pullRequestUrl(group.repository, pr.number)}
      target="_blank"
      rel="noreferrer"
      title="Open the pull request on GitHub"
      className="inline-flex max-w-full items-center gap-1.5 underline-offset-4 hover:text-foreground hover:underline"
    >
      <GitPullRequestIcon aria-hidden className="size-3.5 shrink-0" />
      {pr.title && <span className="truncate text-foreground">{pr.title}</span>}
      <span className="shrink-0">#{pr.number}</span>
    </a>
  );
}
