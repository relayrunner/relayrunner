import type {
  ActivityJob,
  ActivityOptions,
  ActivityPage,
  ActivityQuery,
} from "@relayrunner/activity";
import { api } from "@/lib/api";
import { elapsed } from "@/lib/utils";

export type {
  ActivityFilter,
  ActivityItem,
  ActivityJob,
  ActivityOptions,
  ActivityPage,
  ActivityQuery,
  ActivityResult,
  ActivityRunner,
} from "@relayrunner/activity";

/** A page of the workspace's Activity log, newest first, narrowed on the server by `query`. */
export function getActivity(query: ActivityQuery & { before?: number } = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined) params.set(key, String(value));
  const qs = params.toString();
  return api<ActivityPage>(qs ? `/activity?${qs}` : "/activity");
}

/** The repos and machines the Activity filters can pick from. */
export function getActivityOptions() {
  return api<ActivityOptions>("/activity/options");
}

/** "3m ago", "2h ago", or a date for anything older than a day. */
export function timeAgo(date: string | number, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - new Date(date).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(date).toLocaleDateString();
}

/** "45s", "3m 12s", or null when the job hasn't started. Runs to now while it's in progress. */
export function duration(job: Pick<ActivityJob, "startedAt" | "completedAt">, now = Date.now()) {
  if (!job.startedAt) return null;
  const end = job.completedAt ? Date.parse(job.completedAt) : now;
  return elapsed(end - Date.parse(job.startedAt));
}
