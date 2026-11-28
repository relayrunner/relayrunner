// The dashboard's cache of API reads (TanStack Query). A page's report loads through its route's
// loader into the cache, and panels and sections that read on their own use queries too. A page
// or panel come back to shows what it read last, and two parts asking for the same thing share one
// request.
import {
  type InfiniteData,
  infiniteQueryOptions,
  keepPreviousData,
  QueryClient,
  type QueryKey,
  queryOptions,
  useInfiniteQuery,
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

/**
 * A page's report that lists its rows a page at a time: `queryFn` reads the page from an offset,
 * and `nextOffset` says where the next one starts after `pages` (undefined when there's none).
 */
export function pagedQuery<T>(
  queryKey: QueryKey,
  queryFn: (offset: number) => Promise<T>,
  nextOffset: (pages: T[]) => number | undefined,
) {
  return infiniteQueryOptions<T, Error, InfiniteData<T, number>, QueryKey, number>({
    queryKey,
    queryFn: ({ pageParam }) => queryFn(pageParam),
    initialPageParam: 0,
    getNextPageParam: (_last: T, pages: T[]) => nextOffset(pages),
    staleTime: PAGE_FRESH_MS,
  });
}

type PagedQuery<T> = ReturnType<typeof pagedQuery<T>>;

/** loadPage for a paged report: its first page, or every page it has cached. */
export function loadPages<T>(options: PagedQuery<T>) {
  return queryClient.ensureInfiniteQueryData({ ...options, revalidateIfStale: true });
}

/** usePageReport for a paged report: the pages read so far, and a way to read the next one. */
export function usePagedReport<T>(options: PagedQuery<T>, first: InfiniteData<T, number>) {
  const query = useInfiniteQuery({ ...options, placeholderData: keepPreviousData });
  const last = useRef(first);
  if (query.data !== undefined) last.current = query.data;
  return {
    pages: last.current.pages,
    more: () => void query.fetchNextPage(),
    loadingMore: query.isFetchingNextPage,
  };
}
