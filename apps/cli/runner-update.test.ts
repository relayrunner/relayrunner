import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { keepRunnerUpdated, type RunnerUpdaterOptions } from "./runner-update.ts";

const HOUR = 60 * 60 * 1000;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function start(overrides: Partial<RunnerUpdaterOptions> = {}) {
  const state = { current: "2.329.0", running: 0, latest: "2.329.0", lines: [] as string[] };
  const updates: string[] = [];
  const stop = keepRunnerUpdated({
    current: () => state.current,
    running: () => state.running,
    latest: async () => state.latest,
    update: async (version) => {
      updates.push(version);
      state.current = version;
    },
    log: (line) => state.lines.push(line),
    checkMs: 6 * HOUR,
    busyRetryMs: 10 * 60 * 1000,
    maxWaitMs: 24 * HOUR,
    ...overrides,
  });
  return { state, updates, stop };
}

describe("keepRunnerUpdated", () => {
  test("checks every few hours and updates when GitHub has a newer runner", async () => {
    const { state, updates, stop } = start();
    await vi.advanceTimersByTimeAsync(6 * HOUR);
    expect(updates).toEqual([]);

    state.latest = "2.330.0";
    await vi.advanceTimersByTimeAsync(6 * HOUR - 1);
    expect(updates).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(updates).toEqual(["2.330.0"]);
    expect(state.lines.at(-1)).toBe("Jobs now run on actions/runner 2.330.0.");
    stop();
  });

  test("waits for a moment with no job running", async () => {
    const { state, updates, stop } = start();
    state.latest = "2.330.0";
    state.running = 1;
    await vi.advanceTimersByTimeAsync(7 * HOUR);
    expect(updates).toEqual([]);

    state.running = 0;
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(updates).toEqual(["2.330.0"]);
    stop();
  });

  test("goes ahead on a machine that stays busy for a day, leaving running jobs on the old runner", async () => {
    const { state, updates, stop } = start();
    state.latest = "2.330.0";
    state.running = 2;
    await vi.advanceTimersByTimeAsync(29 * HOUR);
    expect(updates).toEqual([]);
    await vi.advanceTimersByTimeAsync(1 * HOUR);
    expect(updates).toEqual(["2.330.0"]);
    expect(state.lines.at(-1)).toBe(
      "New jobs run on actions/runner 2.330.0. Jobs already running finish on 2.329.0.",
    );
    stop();
  });

  test("says why an update failed and tries again at the next check", async () => {
    let fail = true;
    const { state, updates, stop } = start({
      update: async (version) => {
        if (fail) throw new Error("Could not download the image");
        updates.push(version);
      },
    });
    state.latest = "2.330.0";
    await vi.advanceTimersByTimeAsync(6 * HOUR);
    expect(state.lines.at(-1)).toBe(
      "Couldn't update the runner (Could not download the image). Trying again later.",
    );

    fail = false;
    await vi.advanceTimersByTimeAsync(6 * HOUR);
    expect(updates).toEqual(["2.330.0"]);
    stop();
  });

  test("stops checking once stopped", async () => {
    const latest = vi.fn(async () => "2.330.0");
    const { updates, stop } = start({ latest });
    stop();
    await vi.advanceTimersByTimeAsync(12 * HOUR);
    expect(latest).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });
});
