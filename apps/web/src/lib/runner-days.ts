// A runner's days and online spans for its panel, kept apart from the API so tests can import them.

export type RunnerDay = { day: number; jobs: number; failures: number; busyMs: number };

/** Local midnight `daysAgo` days back. */
export function midnight(daysAgo: number, now = Date.now()) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - daysAgo);
  return date.getTime();
}

/** Every day in the window, oldest first, with the ones the report left out as zeros. */
export function everyDay(report: { days: number; daily: RunnerDay[] }, now = Date.now()) {
  const byDay = new Map(report.daily.map((day) => [day.day, day]));
  return Array.from({ length: report.days }, (_, index) => {
    const day = midnight(report.days - 1 - index, now);
    return byDay.get(day) ?? { day, jobs: 0, failures: 0, busyMs: 0 };
  });
}

/** The machine's live connection, to close the last span with. */
export type LiveConnection = {
  online: boolean;
  /** When the current connection opened. */
  connectedAt: number | null;
  /** When it last connected or disconnected. */
  lastSeenAt: number | null;
};

/**
 * When a machine was online from `since` to now, as [from, to] spans, from its connections and its
 * live state. Before its first connection event it was in the opposite state; with none it's been
 * as it is now all along (or since it connected).
 */
export function onlineSpans(
  connections: { at: number; online: boolean }[],
  live: LiveConnection,
  since: number,
  now = Date.now(),
): [number, number][] {
  const spans: [number, number][] = [];
  const add = (from: number, to: number) => {
    const start = Math.max(from, since);
    if (to > start) spans.push([start, to]);
  };
  const first = connections[0];
  let from: number | null = null;
  if (first ? !first.online : live.online)
    from = first ? -Infinity : (live.connectedAt ?? -Infinity);
  for (const { at, online } of connections) {
    if (online && from === null) from = at;
    else if (!online && from !== null) {
      add(from, at);
      from = null;
    }
  }
  // Still connected, or a lost disconnect: the machine reads offline now, so it went at its last
  // sighting.
  if (from !== null) add(from, live.online ? now : (live.lastSeenAt ?? from));
  return spans;
}
