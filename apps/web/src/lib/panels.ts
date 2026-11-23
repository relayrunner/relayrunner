import { JOB_RANGES } from "@/lib/job-times";
import { HISTORY_DEFAULT_RANGE } from "@/lib/runs";
import type { RangeOptions, TimeRange } from "@/lib/time-range";

// The panels' ranges live here, not beside the panels, so the workspace layout can validate the
// search without loading the panels themselves.

/**
 * A runner panel's ranges, down to the past hour, with bars per 15 minutes, per hour or per day.
 * They reach back 30 days, as far as Performance does.
 */
export const RUNNER_RANGES: RangeOptions = {
  presets: ["1h", "3h", "24h", "2d", "7d", "14d", "30d", "today", "yesterday", "week", "lastweek"],
  customDays: 30,
};
export const RUNNER_DEFAULT_RANGE: TimeRange = "14d";

/** A workflow panel's ranges are History's, opening on the same week. */
export const WORKFLOW_RANGES = JOB_RANGES;
export const WORKFLOW_DEFAULT_RANGE: TimeRange = HISTORY_DEFAULT_RANGE;

/**
 * The search params of the panels that open over any workspace page: a runner's (`runner`) and a
 * workflow's (`wf`, its repo and name), each with its range when that isn't the default. The
 * workflow's param isn't `workflow`, which Performance already uses for its own job detail.
 */
export type PanelSearch = {
  runner?: string;
  runnerRange?: string;
  wf?: string;
  wfRange?: string;
};

/** Every panel closed: spread into a search before opening one, so one panel shows at a time. */
export const CLOSED_PANELS: { [K in keyof PanelSearch]: undefined } = {
  runner: undefined,
  runnerRange: undefined,
  wf: undefined,
  wfRange: undefined,
};
