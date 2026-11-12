import { TONE_LABELS, type MachineView } from "@/components/runner-card";
import { DAY_MS } from "@/lib/job-times";
import type { Machine, MachineSharing } from "@/lib/machines";

/**
 * A self-hosted runner that's been offline this long, with no jobs, is hidden until asked for.
 * The Runners page reads job counts over the same window to tell whether it ran any.
 */
export const INACTIVE_DAYS = 14;

export const STATUSES = Object.entries(TONE_LABELS).map(([value, label]) => ({
  value: value as MachineView["tone"],
  label,
}));

/** The Runners page's filters, kept in the URL so a reload or a shared link keeps them. */
export type RunnerSearch = {
  /** Comma-separated statuses to show. */
  status?: string;
  /** Comma-separated owner names to show. */
  owner?: string;
  /** Whose jobs it takes. */
  runs?: MachineSharing;
  /** Also show inactive runners. */
  inactive?: true;
};

export function validateRunnerSearch(search: Record<string, unknown>): RunnerSearch {
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;
  const runs = search.runs === "only_me" || search.runs === "anyone" ? search.runs : undefined;
  return {
    status: text(search.status),
    owner: text(search.owner),
    runs,
    inactive: [true, 1, "1", "true"].includes(search.inactive as never) ? true : undefined,
  };
}

/** Clears the filters, but not whether inactive runners show. */
export const CLEARED_FILTERS = { status: undefined, owner: undefined, runs: undefined };

/** How many filters are set. */
export function filterCount(search: RunnerSearch) {
  return (
    splitFilter(search.status).length + splitFilter(search.owner).length + (search.runs ? 1 : 0)
  );
}

/** Whether a runner passes the filters. */
export function matchesFilters(view: MachineView, owner: string, search: RunnerSearch) {
  const statuses = splitFilter(search.status);
  const owners = splitFilter(search.owner);
  return (
    (statuses.length === 0 || statuses.includes(view.tone)) &&
    (owners.length === 0 || owners.includes(owner)) &&
    (!search.runs || view.sharing === search.runs)
  );
}

/** The list a comma-separated filter holds. */
export function splitFilter(value: string | undefined) {
  return value ? value.split(",").filter(Boolean) : [];
}

/** A list back to a filter, or undefined for none so the URL stays clean. */
export function joinFilter(values: string[]) {
  return values.length ? values.join(",") : undefined;
}

/** Who it belongs to, as the filter names it: "You", a teammate, or a GitHub org. */
export function ownerOf(machine: Machine, view: MachineView) {
  return view.isGithub ? (machine.owner ?? "GitHub") : (view.ownerName ?? "Unknown");
}

/**
 * Offline, and neither connected nor ran a job in INACTIVE_DAYS. A connected machine has to be
 * online to run jobs, so its last session says enough. A runner added from GitHub has no session,
 * so it waits on `ranJobs` (undefined while that's loading) and reads as active until then.
 */
export function isInactive(
  machine: Machine,
  view: MachineView,
  ranJobs: boolean | undefined,
  now = Date.now(),
) {
  if (view.status.online || ranJobs) return false;
  if (view.isGithub && ranJobs === undefined) return false;
  const last = Math.max(
    Date.parse(machine.createdAt),
    machine.lastSeenAt ? Date.parse(machine.lastSeenAt) : 0,
  );
  return last < now - INACTIVE_DAYS * DAY_MS;
}
