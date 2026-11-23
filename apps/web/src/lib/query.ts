// The dashboard's cache of API reads (TanStack Query). A page's report loads through its route's
// loader into the cache, and panels and sections that read on their own use queries too. A page
// or panel come back to shows what it read last, and two parts asking for the same thing share one
// request.
import {
  keepPreviousData,
  QueryClient,
  type QueryKey,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";
import { useRef } from "react";
import { clearOnWorkspaceChange } from "@/lib/workspace-cache";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A failed read says so, with its own retry where the panel offers one.
      retry: false,
      // Live parts refresh on their own schedule (lib/live-refresh.ts), which already catches up
      // when the tab comes back.
      refetchOnWindowFocus: false,
    },
  },
});

// Reads are one workspace's data.
clearOnWorkspaceChange(() => queryClient.clear());

// How long a page's report counts as fresh. Coming back sooner shows it without asking again;
// coming back later shows it at once and refreshes it behind.
const PAGE_FRESH_MS = 30_000;

/** A page's report: its cache key and how to load it. */
export function pageQuery<T>(queryKey: QueryKey, queryFn: () => Promise<T>) {
  return queryOptions({ queryKey, queryFn, staleTime: PAGE_FRESH_MS });
}

/**
 * For a route's loader: the cached report at once (refreshed behind when it's stale), or the first
 * load. A hover preloads it the same way.
 */
export function loadPage<T>(options: ReturnType<typeof pageQuery<T>>) {
  return queryClient.ensureQueryData({ ...options, revalidateIfStale: true });
}

/**
 * The page's report for `options`, kept fresh. Another key (a new range or filter) loads here with
 * the last report shown until it's back, and the last report stays up if a load fails.
 */
export function usePageReport<T>(options: ReturnType<typeof pageQuery<T>>, first: T) {
  const query = useQuery({ ...options, placeholderData: keepPreviousData });
  const last = useRef(first);
  if (query.data !== undefined) last.current = query.data;
  return { report: last.current, refetch: query.refetch };
}
