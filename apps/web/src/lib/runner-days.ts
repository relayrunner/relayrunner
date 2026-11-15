// A runner's online spans for its panel, kept apart from the API so tests can import them.

export type RunnerBucket = { start: number; jobs: number; failures: number; busyMs: number };

/** The machine's live connection, to close the last span with. */
export type LiveConnection = {
  online: boolean;
  /** When the current connection opened. */
  connectedAt: number | null;
  /** When it last connected or disconnected. */
  lastSeenAt: number | null;
};

/**
 * When a machine was online from `since` to `until` (now by default), as [from, to] spans, from its connections and its
 * live state. Before its first connection event it was in the opposite state; with none it's been
 * as it is now all along (or since it connected).
 */
export function onlineSpans(
  connections: { at: number; online: boolean }[],
  live: LiveConnection,
  since: number,
  now = Date.now(),
  until = now,
): [number, number][] {
  const spans: [number, number][] = [];
  const add = (from: number, to: number) => {
    const start = Math.max(from, since);
    const end = Math.min(to, until);
    if (end > start) spans.push([start, end]);
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
