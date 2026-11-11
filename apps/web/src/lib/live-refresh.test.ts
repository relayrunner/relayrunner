import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { startLiveRefresh, type LiveRefreshPage } from "./live-refresh.ts";

// A page whose visibility and input the test controls.
function fakePage() {
  let visible = true;
  const visibility = new Set<() => void>();
  const activity = new Set<() => void>();
  const page: LiveRefreshPage = {
    isVisible: () => visible,
    onVisibilityChange: (listener) => (visibility.add(listener), () => visibility.delete(listener)),
    onActivity: (listener) => (activity.add(listener), () => activity.delete(listener)),
  };
  return {
    page,
    setVisible(next: boolean) {
      visible = next;
      for (const listener of visibility) listener();
    },
    input() {
      for (const listener of activity) listener();
    },
  };
}

const options = { intervalMs: 15_000, idleMs: 60_000 };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("refreshing a live page", () => {
  test("happens every interval while visible and in use", () => {
    const { page, input } = fakePage();
    const refresh = vi.fn();
    startLiveRefresh(refresh, options, page);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(15_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    input();
    vi.advanceTimersByTime(30_000);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  test("stops while the tab is hidden, and catches up as soon as it's shown", () => {
    const { page, setVisible } = fakePage();
    const refresh = vi.fn();
    startLiveRefresh(refresh, options, page);
    setVisible(false);
    vi.advanceTimersByTime(10 * 60_000);
    expect(refresh).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    setVisible(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(15_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  test("doesn't refresh again when the tab comes back within the interval", () => {
    const { page, setVisible } = fakePage();
    const refresh = vi.fn();
    startLiveRefresh(refresh, options, page);
    vi.advanceTimersByTime(5_000);
    setVisible(false);
    setVisible(true);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test("stops after a while with no input, and picks up again on the next one", () => {
    const { page, input } = fakePage();
    const refresh = vi.fn();
    startLiveRefresh(refresh, options, page);
    // 15s, 30s and 45s; at 60s it's idle.
    vi.advanceTimersByTime(60_000);
    expect(refresh).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(10 * 60_000);
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    input();
    expect(refresh).toHaveBeenCalledTimes(4);
  });

  test("isn't brought forward by input", () => {
    const { page, input } = fakePage();
    const refresh = vi.fn();
    startLiveRefresh(refresh, options, page);
    for (let i = 0; i < 14; i++) {
      vi.advanceTimersByTime(1_000);
      input();
    }
    expect(refresh).not.toHaveBeenCalled();
  });

  test("ends when stopped", () => {
    const { page } = fakePage();
    const refresh = vi.fn();
    const stop = startLiveRefresh(refresh, options, page);
    stop();
    vi.advanceTimersByTime(60_000);
    expect(refresh).not.toHaveBeenCalled();
  });
});
