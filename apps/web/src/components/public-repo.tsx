import { GlobeIcon } from "lucide-react";
import { useIsPublicRepo } from "@/lib/public-repos";
import { cn } from "@/lib/utils";

/**
 * A globe after a repo's name when the repo is public, and nothing when it's private. Only public
 * repos are marked: they're the exception, and the one that routes differently (machines never
 * take their jobs). Spaced for running text; a flex parent with its own gap passes `ml-0`.
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
      title="Public repo"
      className={cn("ml-1 inline-flex shrink-0 align-[-0.1em] text-muted-foreground", className)}
    >
      <GlobeIcon aria-label="Public repo" className="size-3" />
    </span>
  );
}
