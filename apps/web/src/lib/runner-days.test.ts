import { describe, expect, test } from "vitest";
import { everyBucket, onlineSpans } from "./runner-days.ts";

const offline = { online: false, connectedAt: null, lastSeenAt: null };

describe("onlineSpans", () => {
  test("pairs connections with disconnections, from the window's start", () => {
    const events = [
      { at: 5, online: false },
      { at: 10, online: true },
      { at: 20, online: false },
      { at: 30, online: true },
    ];
    // Online before its first event (a disconnect), and still online now.
    expect(onlineSpans(events, { ...offline, online: true }, 0, 50)).toEqual([
      [0, 5],
      [10, 20],
      [30, 50],
    ]);
    // Offline now with no disconnect seen: it went when it was last seen.
    expect(onlineSpans(events, { ...offline, lastSeenAt: 40 }, 0, 50)).toEqual([
      [0, 5],
      [10, 20],
      [30, 40],
    ]);
  });

  test("clips spans to the window", () => {
    expect(onlineSpans([{ at: 5, online: true }], { ...offline, online: true }, 10, 50)).toEqual([
      [10, 50],
    ]);
  });

  test("with no events, goes by the live state", () => {
    expect(onlineSpans([], offline, 0, 50)).toEqual([]);
    expect(onlineSpans([], { online: true, connectedAt: 20, lastSeenAt: null }, 0, 50)).toEqual([
      [20, 50],
    ]);
    expect(onlineSpans([], { online: true, connectedAt: null, lastSeenAt: null }, 0, 50)).toEqual([
      [0, 50],
    ]);
  });
});

describe("everyBucket", () => {
  test("fills bars without jobs with zeros, on the API's grid", () => {
    const hour = 3_600_000;
    const day = 24 * hour;
    const from = Date.UTC(2026, 10, 12, 15);
    const report = {
      from,
      to: from + 2 * day,
      bucketMs: day,
      // UTC+2 midnight on Nov 14 is 22:00 UTC on Nov 13.
      buckets: [{ start: Date.UTC(2026, 10, 13, 22), jobs: 4, failures: 1, busyMs: 9 }],
    };
    const bars = everyBucket(report, 120);
    expect(bars.map((bar) => new Date(bar.start).toISOString())).toEqual([
      "2026-11-11T22:00:00.000Z",
      "2026-11-12T22:00:00.000Z",
      "2026-11-13T22:00:00.000Z",
    ]);
    expect(bars.map((bar) => bar.jobs)).toEqual([0, 0, 4]);
    expect(everyBucket({ ...report, bucketMs: hour, to: from + 3 * hour }, 0)).toHaveLength(3);
  });
});
