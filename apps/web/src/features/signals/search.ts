// The Signals page's URL state: range, filters, breakdown and the open signal row. Light enough for
// the route's loader to import.
import { DOCS_URL } from "@/components/site-footer";
import {
  BREAKDOWN_VIEWS,
  type BreakdownBy,
  FILTER_KEYS,
  isFiltered,
  type SignalFilter,
  type SignalId,
  SIGNAL_COPY,
} from "@/lib/signals";
import { optionParam, rangeSearch, textParam } from "@/lib/search-params";
import { type RangeOptions, type TimeRange, timeRangeParam } from "@/lib/time-range";

export const RANGES: RangeOptions = {
  presets: ["7d", "14d", "30d", "90d", "week", "lastweek", "month", "lastmonth"],
};

// A filtered page works from single jobs over the last 30 days (FILTERED_MAX_DAYS in lib/signals),
// not as far back as the daily rollup.
export const FILTERED_RANGES: RangeOptions = {
  presets: ["7d", "14d", "30d", "week", "lastweek", "month"],
};

const DEFAULT_RANGE: TimeRange = "30d";

export const ranges = rangeSearch(RANGES, DEFAULT_RANGE);

export const BREAKDOWNS = BREAKDOWN_VIEWS.map((option) => option.value);

const SIGNAL_IDS = Object.keys(SIGNAL_COPY) as SignalId[];

// `by` is how the Breakdown splits jobs; the filter's values narrow the page; `signal`, `in` and
// `subject` name the signal row whose runs are open in the panel.
export type Search = { range?: TimeRange; by?: BreakdownBy } & SignalFilter & {
    signal?: SignalId;
    in?: string;
    subject?: string;
  };

export const validateSearch = (search: Record<string, unknown>): Search => {
  const signal = SIGNAL_IDS.includes(search.signal as SignalId)
    ? (search.signal as SignalId)
    : undefined;
  const row = signal && textParam(search.in) && textParam(search.subject);
  return {
    ...ranges.validateSearch(search),
    by: optionParam(search.by, BREAKDOWNS),
    ...Object.fromEntries(FILTER_KEYS.map((key) => [key, textParam(search[key])])),
    signal: row ? signal : undefined,
    in: row ? textParam(search.in) : undefined,
    subject: row ? textParam(search.subject) : undefined,
  };
};

export const filterOf = (search: Search): SignalFilter =>
  Object.fromEntries(FILTER_KEYS.map((key) => [key, search[key]]));

/** The page's range: a filtered page's is at most 30 days. */
export function rangeOf(search: Search) {
  const range = ranges.rangeOf(search);
  if (!isFiltered(search)) return range;
  return timeRangeParam(range, FILTERED_RANGES, DEFAULT_RANGE) ?? DEFAULT_RANGE;
}

// Every filter key, cleared.
export const NO_FILTER = Object.fromEntries(
  FILTER_KEYS.map((key) => [key, undefined]),
) as SignalFilter;

export const SIGNALS_DOCS = `${DOCS_URL}/dashboard/signals`;

// A signal's section on the docs page: Starlight's heading id for its title.
export const docsAnchor = (title: string) =>
  `${SIGNALS_DOCS}#${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

// The range and filter a report is for.
export const keyOf = (range: TimeRange, filter: SignalFilter) =>
  JSON.stringify([range, ...FILTER_KEYS.map((key) => filter[key] ?? "")]);
