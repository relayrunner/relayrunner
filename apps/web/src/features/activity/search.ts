// The Activity page's URL filters and how they map to the API's query. Light enough for the
// route's loader to import.
import { type ActivityFilter, type ActivityQuery, type ActivityResult } from "@/lib/activity";
import { DAY_MS } from "@/lib/job-times";

export const TYPES: { value: ActivityFilter | undefined; label: string }[] = [
  { value: undefined, label: "All" },
  { value: "job", label: "Jobs" },
  { value: "check", label: "Checks" },
  { value: "machine", label: "Machines" },
  { value: "member", label: "Members" },
  { value: "settings", label: "Settings" },
];

export const RANGES = [
  { days: 1, label: "Last 24 hours" },
  { days: 7, label: "Last 7 days" },
  { days: 30, label: "Last 30 days" },
];

export const RESULTS: { value: ActivityResult; label: string }[] = [
  { value: "passed", label: "Passed" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "skipped", label: "Skipped" },
  { value: "running", label: "In progress" },
];

// A Select needs a value for "no filter".
export const ANY = "any";

/** The filters, kept in the URL so a filtered view can be shared or bookmarked. */
export type ActivitySearch = {
  type?: ActivityFilter;
  days?: number;
  repo?: string;
  result?: ActivityResult;
  machine?: string;
};

export function oneOf<T>(values: readonly T[], value: unknown): T | undefined {
  return values.find((option) => option === value);
}

export const text = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value.slice(0, 200) : undefined;

// Which filters mean something for each kind of event: a member change has no repo, result or
// machine; a check runs on no machine; a machine event has no repo or result.
export function appliesTo(type: ActivityFilter | undefined) {
  const jobOrCheck = type === undefined || type === "job" || type === "check";
  return {
    repo: jobOrCheck,
    result: jobOrCheck,
    machine: type === undefined || type === "job" || type === "machine",
  };
}

export function toQuery(search: ActivitySearch): ActivityQuery {
  return {
    filter: search.type,
    since: search.days ? Date.now() - search.days * DAY_MS : undefined,
    repository: search.repo,
    result: search.result,
    machine: search.machine,
  };
}

export const CLEARED: ActivitySearch = {
  days: undefined,
  repo: undefined,
  result: undefined,
  machine: undefined,
};
