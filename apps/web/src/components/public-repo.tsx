import { useIsPublicRepo } from "@/lib/public-repos";
import { cn } from "@/lib/utils";

/**
 * Quiet "public" text after a repo's name when the repo is public, and nothing when it's private.
 * Only public repos are marked: they're the exception, and the one that routes differently
 * (machines never take their jobs). Spaced for running text; a flex parent with its own gap passes
 * `ml-0`.
 */
export function PublicRepoMark({
  repository,
  className,
}: {
  repository: string | null | undefined;
  className?: string;
}) {
  if (!useIsPublicRepo(repository)) return null;
  return (
    <span
      className={cn(
        "ml-1.5 shrink-0 font-sans text-xs font-normal text-muted-foreground",
        className,
      )}
    >
      public
    </span>
  );
}
