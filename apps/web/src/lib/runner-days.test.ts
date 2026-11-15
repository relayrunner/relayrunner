import { describe, expect, test } from "vitest";
import { onlineSpans } from "./runner-days.ts";

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
