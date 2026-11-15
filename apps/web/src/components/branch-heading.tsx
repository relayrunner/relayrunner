import { ChevronRightIcon, GitBranchIcon, GitPullRequestIcon } from "lucide-react";
import type { BranchGroup } from "@/lib/branch-groups";
import { plural } from "@/lib/job-times";
import { pullRequestUrl } from "@/lib/runs";
import { cn } from "@/lib/utils";

/**
 * A group of jobs' heading row content: a toggle that folds its jobs away, then its pull request
 * when a run came from one, else its branch, then how many jobs it holds.
 */
export function BranchHeading({
  group,
  open,
  onToggle,
}: {
  group: BranchGroup<unknown>;
  open: boolean;
  onToggle: () => void;
}) {
  const pr = group.pullRequest;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? "Hide these jobs" : "Show these jobs"}
        onClick={onToggle}
        className="-my-1 grid size-5 shrink-0 place-items-center rounded-sm outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn("size-3.5 transition-transform", open && "rotate-90")}
        />
      </button>
      {pr ? (
        <a
          href={pullRequestUrl(group.repository, pr.number)}
          target="_blank"
          rel="noreferrer"
          title="Open the pull request on GitHub"
          className="inline-flex min-w-0 items-center gap-1.5 underline-offset-4 hover:text-foreground hover:underline"
        >
          <GitPullRequestIcon aria-hidden className="size-3.5 shrink-0" />
          {pr.title && <span className="truncate font-medium text-foreground">{pr.title}</span>}
          <span className="shrink-0">#{pr.number}</span>
        </a>
      ) : (
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <GitBranchIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate font-medium text-foreground">{group.branch}</span>
        </span>
      )}
      <span className="shrink-0">· {plural(group.jobs.length, "job")}</span>
    </span>
  );
}

/** Which groups someone folded away, by key. Groups start open. */
export function toggleKey(keys: ReadonlySet<string>, key: string) {
  const next = new Set(keys);
  if (!next.delete(key)) next.add(key);
  return next;
}
