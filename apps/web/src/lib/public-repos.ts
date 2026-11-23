import { queryOptions, useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { api } from "@/lib/api";

// Repo visibility changes rarely, so one read serves every page for a while.
const FRESH_MS = 10 * 60_000;

/** GET /api/workspaces/:id/public-repos: the workspace's public repos, lowercased for lookup. */
const publicReposQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ["public-repos", workspaceId],
    queryFn: async () => {
      const path = `/workspaces/${encodeURIComponent(workspaceId)}/public-repos`;
      const { repositories } = await api<{ repositories: string[] }>(path);
      return new Set(repositories.map((name) => name.toLowerCase()));
    },
    staleTime: FRESH_MS,
  });

/**
 * Whether `repository` (owner/name) is public. False until the list loads, and for repos the
 * installation can't see. Pages under the workspace layout only.
 */
export function useIsPublicRepo(repository: string | null | undefined): boolean {
  const workspaceId = useRouteContext({
    from: "/_authed/_workspace",
    select: (context) => context.current.workspace.id,
  });
  const { data } = useQuery(publicReposQuery(workspaceId));
  return Boolean(repository && data?.has(repository.toLowerCase()));
}
