import { api } from "@/lib/api";
import type { Environment, Stat } from "@/lib/job-times";
import type { RunnerBucket } from "./runner-days.ts";
import type { HistoryJob } from "./runs.ts";
import { zoneOffset } from "@/lib/time-zone";
export type RunnerJob = Omit<HistoryJob, "usage">;

/** One runner over a window (GET /api/job-times/runner), for its detail panel. */
export type RunnerReport = {
  /** The window, in epoch ms. */
  from: number;
  to: number;
  /** How long each bar spans: 15 minutes, an hour or a day, by how long the window is. */
  bucketMs: number;
  environment: Environment;
  stat: Stat;
  /** Jobs sent here that no runner picked up within 10 minutes. */
  missed: number;
  /** Every bar in the window, oldest first, cut at the reader's midnight and hours. */
  buckets: RunnerBucket[];
  /** Newest first. */
  recent: RunnerJob[];
  /** A connected machine's connections in the window, oldest first; null for any other runner. */
  connections: { at: number; online: boolean }[] | null;
};

/** The reader's minutes east of UTC, in their chosen zone, which bars are cut at. */
export const utcOffset = () => zoneOffset(Date.now());

export function getRunnerReport(key: string, { from, to }: { from: number; to: number }) {
  const query = new URLSearchParams({
    key,
    from: String(from),
    to: String(to),
    utcOffset: String(utcOffset()),
  });
  return api<RunnerReport>(`/job-times/runner?${query}`);
}
