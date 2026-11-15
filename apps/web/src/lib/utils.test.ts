import { describe, expect, it } from "vitest";
import { count, exact, niceMax } from "./utils";

describe("count", () => {
  it("keeps counts under 1,000 as they are", () => {
    expect(count(0)).toBe("0");
    expect(count(999)).toBe("999");
  });

  it("shortens 1,000 and up to one decimal", () => {
    expect(count(1000)).toBe("1K");
    expect(count(1149)).toBe("1.1K");
    expect(count(24_310)).toBe("24.3K");
    expect(count(1_250_000)).toBe("1.3M");
  });

  it("gives the full number for the hover", () => {
    expect(exact(1149)).toBe("1,149");
  });
});

describe("niceMax", () => {
  it("rounds a chart's top up with headroom", () => {
    expect([0, 1, 4, 9, 14, 43, 95].map(niceMax)).toEqual([1, 1.2, 5, 10, 20, 50, 120]);
  });
});
