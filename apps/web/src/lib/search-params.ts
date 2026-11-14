// A page's range and filters live in its URL, so a view can be linked to. Each is left out of the
// URL while it's at its default, so a plain link shows the page as it always has.
import { useEffect, useState } from "react";

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
