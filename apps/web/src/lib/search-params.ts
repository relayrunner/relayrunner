// A page's range and filters live in its URL, so a view can be linked to. Each is left out of the
// URL while it's at its default, so a plain link shows the page as it always has.
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

/** The day ranges every page's time range menu picks from, so the menu reads the same everywhere. */
export const DAY_RANGES = [1, 7, 14, 30, 90] as const;

/** The day ranges from `min` to `max` days: a page leaves out the ones its data can't show. */
export const dayRanges = (min: number, max: number): readonly number[] =>
  DAY_RANGES.filter((days) => days >= min && days <= max);

/** `?days=` when it's one of the page's ranges other than its default. */
export function rangeParam(value: unknown, ranges: readonly number[], fallback: number) {
  const days = Number(value);
  return ranges.includes(days) && days !== fallback ? days : undefined;
}

/** A choice from the URL when it's one of `options` other than the first, the default. */
export function optionParam<V extends string>(value: unknown, options: readonly V[]) {
  return options.slice(1).includes(value as V) ? (value as V) : undefined;
}

/** Free text from the URL, such as a repo or a search, when there is any. */
export const textParam = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/**
 * Sets some of the page's params, keeping the rest. A filter change replaces the history entry, so
 * the back button leaves the page rather than stepping through each choice.
 */
export function useSetSearch<S>() {
  const navigate = useNavigate();
  return (patch: Partial<S>) =>
    void navigate({
      to: ".",
      search: ((prev: S) => ({ ...prev, ...patch })) as never,
      replace: true,
    });
}

/** The value to put in the URL: nothing for the default. */
export const unlessDefault = <V>(value: V, fallback: V) => (value === fallback ? undefined : value);

/**
 * A report for the range in the URL. The route's loader reads the first one; another range loads
 * here, with the last report shown until it's back.
 */
export function useRangeReport<T>(
  first: T,
  days: number,
  load: (days: number) => Promise<T>,
  daysOf: (report: T) => number = (report) => (report as { days: number }).days,
) {
  const [report, setReport] = useState(first);
  useEffect(() => setReport(first), [first]);
  useEffect(() => {
    if (daysOf(report) === days) return;
    let live = true;
    load(days)
      .then((next) => live && setReport(next))
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new range loads
  }, [days]);
  return report;
}
