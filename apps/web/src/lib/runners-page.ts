// The Runners page's reads, as queries (lib/query.ts). The page shows at once and each section
// fills in when its own read comes back, so a slow one (the machines list asks GitHub about
// runners added from there) never holds up the rest. The route's loader starts them all together,
// and coming back to the page shows the last answers while they refresh.
import { queryOptions } from "@tanstack/react-query";
import { getMachineJobTimes } from "@/lib/job-times";
import { getLiveJobs, NO_LIVE_JOBS } from "@/lib/live-jobs";
import { machinesQuery } from "@/lib/machines";
import { getProvidersOverview } from "@/lib/providers";
import { queryClient } from "@/lib/query";
import { getRunnerOrder } from "@/lib/runner-order";
import type { TimeRange } from "@/lib/time-range";

/** How old an answer can be before coming back to the page reads it again, behind what's shown. */
const FRESH_MS = 30_000;

/** Jobs running and queued right now. A failed read shows none; the next refresh tries again. */
export const liveJobsQuery = queryOptions({
  queryKey: ["live-jobs"],
  queryFn: () => getLiveJobs().catch(() => NO_LIVE_JOBS),
  staleTime: FRESH_MS,
});

export const runnerOrderQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ["runner-order", workspaceId],
    queryFn: () => getRunnerOrder(workspaceId),
    staleTime: FRESH_MS,
  });

/** Each machine's jobs over the last `days`, for the cards and for hiding inactive runners. */
export const machineJobTimesQuery = (days: number) =>
  queryOptions({
    queryKey: ["job-times", "machines", days],
    queryFn: async () => (await getMachineJobTimes(days)).machines,
    staleTime: FRESH_MS,
  });

/** What jobs used in the cloud over `range`, for the Cloud-hosted section. */
export const cloudRunnersQuery = (range: TimeRange) =>
  queryOptions({
    queryKey: ["providers", "overview", range],
    queryFn: async () => (await getProvidersOverview(range)).providers,
    staleTime: FRESH_MS,
  });

/** Starts every read the page makes, without waiting on any. */
export function prefetchRunnersPage(workspaceId: string, cloudRange: TimeRange, jobDays: number) {
  void queryClient.prefetchQuery(machinesQuery);
  void queryClient.prefetchQuery(liveJobsQuery);
  void queryClient.prefetchQuery(runnerOrderQuery(workspaceId));
  void queryClient.prefetchQuery(machineJobTimesQuery(jobDays));
  void queryClient.prefetchQuery(cloudRunnersQuery(cloudRange));
}
