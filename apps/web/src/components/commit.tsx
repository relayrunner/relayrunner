import { GitCommitHorizontalIcon } from "lucide-react";
import { UserAvatar } from "@/components/workspace-menu";
import { cn } from "@/lib/utils";

/** A commit's short sha, as GitHub shows it. */
export const shortSha = (sha: string) => sha.slice(0, 7);

/** A GitHub account's small avatar and its name, the login unless `name` is given. */
export function GithubUser({
  login,
  name = login,
  nameClassName,
}: {
  login: string;
  name?: string;
  nameClassName?: string;
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <UserAvatar
        user={{ name, image: `https://github.com/${encodeURIComponent(login)}.png?size=32` }}
        className="size-4 border-0 text-[8px]"
      />
      <span className={cn("truncate", nameClassName)}>{name}</span>
    </span>
  );
}

/**
 * Who started a run and its short commit, under a run or job's name. With `repository`, the commit
 * links to GitHub, for places that aren't already inside a link. Nothing for runs from before
 * either was stored.
 */
export function CommitBy({
  actor,
  sha,
  repository,
  className,
}: {
  actor: string | null;
  sha: string | null;
  repository?: string;
  className?: string;
}) {
  if (!actor && !sha) return null;
  const commit = sha && (
    <>
      <GitCommitHorizontalIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="font-mono">{shortSha(sha)}</span>
    </>
  );
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-x-2.5", className)}>
      {actor && <GithubUser login={actor} />}
      {commit &&
        (repository ? (
          <a
            href={`https://github.com/${repository}/commit/${sha}`}
            target="_blank"
            rel="noreferrer"
            title="Open the commit on GitHub"
            className="inline-flex shrink-0 items-center gap-1 underline-offset-4 hover:text-foreground hover:underline"
          >
            {commit}
          </a>
        ) : (
          <span className="inline-flex shrink-0 items-center gap-1">{commit}</span>
        ))}
    </span>
  );
}
