import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cached, forgetReportCache, settledWindow } from "./report-cache.ts";

// A stand-in for the Workers Cache API: what was put, by URL.
function fakeEdge() {
  const stored = new Map<string, Response>();
  return {
    stored,
    match: async (request: Request) => stored.get(request.url)?.clone(),
    put: async (request: Request, response: Response) => void stored.set(request.url, response),
  };
}

describe("cached", () => {
  let edge: ReturnType<typeof fakeEdge>;
  beforeEach(() => {
    edge = fakeEdge();
    vi.stubGlobal("caches", { default: edge });
    forgetReportCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("reads once while the value is fresh", async () => {
    const read = vi.fn(async () => ({ rows: [1, 2] }));
    expect(await cached("k", 1_000, read)).toEqual({ rows: [1, 2] });
    expect(await cached("k", 1_000, read)).toEqual({ rows: [1, 2] });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("shares a value through the Cache API with other isolates", async () => {
    await cached("k", 1_000, async () => "first");
    forgetReportCache(); // Another isolate: nothing in memory.
    expect(await cached("k", 1_000, async () => "second")).toBe("first");
    expect(edge.stored.size).toBe(1);
  });

  it("reads again once the value is older than its time", async () => {
    vi.useFakeTimers({ now: 0 });
    await cached("k", 1_000, async () => "old");
    edge.stored.clear(); // The Cache API let it go at max-age too.
    vi.setSystemTime(1_001);
    expect(await cached("k", 1_000, async () => "new")).toBe("new");
  });

  it("keeps keys apart", async () => {
    await cached("a", 1_000, async () => "a");
    expect(await cached("b", 1_000, async () => "b")).toBe("b");
  });

  it("reads every time without the Cache API, as in Node", async () => {
    vi.unstubAllGlobals();
    const read = vi.fn(async () => 1);
    await cached("k", 1_000, read);
    await cached("k", 1_000, read);
    expect(read).toHaveBeenCalledTimes(2);
  });
});

it("moves a window to 10-minute marks", () => {
  const min = 60_000;
  expect(settledWindow({ from: 12 * min + 5, to: 29 * min })).toEqual({
    from: 10 * min,
    to: 20 * min,
  });
});
