import { describe, expect, test, vi } from "vitest";

vi.mock("@/lib/api", () => ({ api: {} }));
vi.mock("@/lib/utils", () => ({ count: String }));

const { isSlow, progressOf, progressText } = await import("./job-times.ts");

const typical = (medianMs: number, p90Ms: number) => ({ medianMs, p90Ms, samples: 20 });

describe("isSlow", () => {
  test("ignores small variance past the p90", () => {
    // 1:31 against a usual 1:22 with a tight p90.
    expect(isSlow(typical(82_000, 88_000), 91_000)).toBe(false);
    expect(isSlow(typical(20_000, 21_000), 24_000)).toBe(false);
  });

  test("needs 30s past the median on short jobs", () => {
    expect(isSlow(typical(60_000, 65_000), 89_000)).toBe(false);
    expect(isSlow(typical(60_000, 65_000), 90_000)).toBe(true);
  });

  test("needs a quarter past the median on long jobs", () => {
    expect(isSlow(typical(600_000, 620_000), 740_000)).toBe(false);
    expect(isSlow(typical(600_000, 620_000), 750_000)).toBe(true);
  });

  test("stays within a job's usual spread", () => {
    expect(isSlow(typical(60_000, 120_000), 110_000)).toBe(false);
    expect(isSlow(typical(60_000, 120_000), 121_000)).toBe(true);
  });

  test("needs a usual time", () => {
    expect(isSlow(null, 1_000_000)).toBe(false);
  });
});

describe("progressText", () => {
  const t = typical(82_000, 88_000);
  test("shows the time left before the usual time", () => {
    expect(progressText(progressOf(t, 62_000)!)).toBe("about 0:20 left");
  });
  test("says nothing once past it but still normal", () => {
    expect(progressText(progressOf(t, 91_000)!)).toBeNull();
  });
  test("warns once meaningfully slower", () => {
    expect(progressText(progressOf(t, 115_000)!)).toBe("slower than usual (1:22)");
  });
});
