// A page's range and filters live in its URL, so a view can be linked to. Each is left out of the
// URL while it's at its default, so a plain link shows the page as it always has.
import { useNavigate } from "@tanstack/react-router";
import { type RangeOptions, rangeOrDaysParam, type TimeRange } from "./time-range";

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
      // The page stays where it is: only part of it changes.
      resetScroll: false,
    });
}

/** The value to put in the URL: nothing for the default. */
export const unlessDefault = <V>(value: V, fallback: V) => (value === fallback ? undefined : value);

/** A report page's `?range=` (an older link's `?days=` still works), left out at its default. */
export type RangeSearch = { range?: TimeRange };

/** How a report page reads and writes its `?range=`: `options` it offers, `fallback` its default. */
export function rangeSearch(options: RangeOptions, fallback: TimeRange) {
  return {
    validateSearch: (search: Record<string, unknown>): RangeSearch => ({
      range: rangeOrDaysParam(search.range, search.days, options, fallback),
    }),
    rangeOf: (search: RangeSearch) => search.range ?? fallback,
    toSearch: (range: TimeRange): RangeSearch => ({ range: unlessDefault(range, fallback) }),
  };
}
