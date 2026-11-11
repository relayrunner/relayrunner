import { useEffect, useRef } from "react";

// Stop refreshing after this long with no input, even while the tab is visible: a dashboard left
// open on a second screen shouldn't poll all night.
export const IDLE_MS = 5 * 60_000;

// What counts as someone being there.
const ACTIVITY_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "scroll", "focus"];

export type LiveRefreshOptions = {
  intervalMs: number;
  idleMs?: number;
};

/** The parts of the page startLiveRefresh watches, so tests can hand in fakes. */
export type LiveRefreshPage = {
  isVisible: () => boolean;
  onVisibilityChange: (listener: () => void) => () => void;
  onActivity: (listener: () => void) => () => void;
};

export const browserPage: LiveRefreshPage = {
  isVisible: () => document.visibilityState === "visible",
  onVisibilityChange(listener) {
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  },
  onActivity(listener) {
    const options = { capture: true, passive: true };
    for (const type of ACTIVITY_EVENTS) window.addEventListener(type, listener, options);
    return () => {
      for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, listener, options);
    };
  },
};

/**
 * Calls `refresh` every `intervalMs` while the tab is visible and someone has used the page in the
 * last `idleMs`. While hidden or idle no timer runs at all. Coming back (the tab shown again, or
 * any input after going idle) refreshes at once if the last refresh is older than the interval,
 * so what's on screen is never stale for longer than it takes to look. Returns a stop function.
 */
export function startLiveRefresh(
  refresh: () => unknown,
  { intervalMs, idleMs = IDLE_MS }: LiveRefreshOptions,
  page: LiveRefreshPage = browserPage,
  now: () => number = Date.now,
): () => void {
  let lastRefresh = now();
  let lastActivity = now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const live = () => page.isVisible() && now() - lastActivity < idleMs;

  // Refreshes if one is due, then sets the next tick. Does nothing while hidden or idle.
  function tick() {
    clearTimeout(timer);
    timer = undefined;
    if (!live()) return;
    if (now() - lastRefresh >= intervalMs) {
      lastRefresh = now();
      void refresh();
    }
    const untilRefresh = lastRefresh + intervalMs - now();
    const untilIdle = lastActivity + idleMs - now();
    // The next refresh, or the moment the page goes idle if that comes first.
    timer = setTimeout(tick, Math.max(0, Math.min(untilRefresh, untilIdle)));
  }

  const stopVisibility = page.onVisibilityChange(() => {
    // Showing the tab counts as someone being there.
    if (page.isVisible()) lastActivity = now();
    tick();
  });
  const stopActivity = page.onActivity(() => {
    const wasIdle = now() - lastActivity >= idleMs;
    lastActivity = now();
    // Most input lands while already live, with a timer set: nothing more to do.
    if (wasIdle || timer === undefined) tick();
  });
  tick();

  return () => {
    clearTimeout(timer);
    stopVisibility();
    stopActivity();
  };
}

/**
 * startLiveRefresh for a component. `refresh` may change between renders without restarting the
 * timer; changing `intervalMs` or `enabled` restarts it.
 */
export function useLiveRefresh(
  refresh: () => unknown,
  { intervalMs, idleMs, enabled = true }: LiveRefreshOptions & { enabled?: boolean },
) {
  const latest = useRef(refresh);
  latest.current = refresh;
  useEffect(() => {
    if (!enabled) return;
    return startLiveRefresh(() => latest.current(), { intervalMs, idleMs });
  }, [intervalMs, idleMs, enabled]);
}
