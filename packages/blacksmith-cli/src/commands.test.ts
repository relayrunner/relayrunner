import { describe, expect, test } from "vitest";
import {
  isAuthFailure,
  jobsArgs,
  jobsSince,
  nextCursor,
  rfc3339,
  scrub,
  usageArgs,
  validOrganization,
} from "./commands.ts";

const now = new Date("2026-11-20T19:00:00Z");
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);

describe("jobsSince", () => {
  test("picks the smallest lookback that reaches the start", () => {
    expect(jobsSince(hoursAgo(8), now)).toBe("24h");
    expect(jobsSince(hoursAgo(24), now)).toBe("24h");
    expect(jobsSince(hoursAgo(25), now)).toBe("7d");
    expect(jobsSince(hoursAgo(10 * 24), now)).toBe("14d");
    expect(jobsSince(hoursAgo(30 * 24), now)).toBe("30d");
  });

  test("caps at 30 days, the longest the CLI takes", () => {
    expect(jobsSince(hoursAgo(89 * 24), now)).toBe("30d");
  });
});

describe("arguments", () => {
  test("usage reads daily totals between two times", () => {
    expect(usageArgs("2026-11-01T00:00:00Z", "2026-11-20T19:00:00Z")).toEqual([
      "usage",
      "--start-time",
      "2026-11-01T00:00:00Z",
      "--end-time",
      "2026-11-20T19:00:00Z",
      "--breakdown-by",
      "day",
      "--format",
      "json",
    ]);
  });

  test("jobs list adds the cursor only after the first page", () => {
    expect(jobsArgs("7d", null)).toEqual([
      "jobs",
      "list",
      "--since",
      "7d",
      "--limit",
      "100",
      "--format",
      "json",
    ]);
    expect(jobsArgs("7d", "abc").slice(-2)).toEqual(["--cursor", "abc"]);
  });

  test("times go to the CLI as RFC 3339 without milliseconds", () => {
    expect(rfc3339("2026-11-20T18:59:41.123Z")).toBe("2026-11-20T18:59:41Z");
    expect(rfc3339("not a date")).toBeNull();
    expect(rfc3339(42)).toBeNull();
  });

  test("an organization is a GitHub login, never a flag", () => {
    expect(validOrganization("relayrunner")).toBe(true);
    expect(validOrganization("my-org-2")).toBe(true);
    expect(validOrganization("--help")).toBe(false);
    expect(validOrganization("org name")).toBe(false);
    expect(validOrganization("")).toBe(false);
  });
});

describe("nextCursor", () => {
  const start = new Date("2026-11-19T00:00:00Z");
  const page = (createdAt: string[], cursor: string | null) => ({
    jobs: createdAt.map((created_at) => ({ created_at })),
    next_cursor: cursor,
  });

  test("follows the cursor while the page is still inside the window", () => {
    expect(nextCursor(page(["2026-11-20T03:59:59Z", "2026-11-19T19:14:09Z"], "next"), start)).toBe(
      "next",
    );
  });

  test("stops once a page reaches back before the start", () => {
    expect(
      nextCursor(page(["2026-11-19T01:00:00Z", "2026-11-18T23:00:00Z"], "next"), start),
    ).toBeNull();
  });

  test("stops on the last page", () => {
    expect(nextCursor(page(["2026-11-20T03:59:59Z"], null), start)).toBeNull();
    expect(nextCursor(page(["2026-11-20T03:59:59Z"], ""), start)).toBeNull();
    expect(nextCursor(null, start)).toBeNull();
  });
});

describe("output", () => {
  test("recognizes a refused token", () => {
    expect(isAuthFailure("Error: 401 Unauthorized")).toBe(true);
    expect(isAuthFailure("error: invalid api token")).toBe(true);
    expect(isAuthFailure("the token is revoked")).toBe(true);
    expect(isAuthFailure("dial tcp: i/o timeout")).toBe(false);
  });

  test("takes the token out of anything sent back", () => {
    const token = "3760036089|1sQAf5abcdefghijklmnop";
    expect(scrub(`bad token ${token}`, token)).toBe("bad token [token]");
    expect(scrub("secret 1sQAf5abcdefghijklmnop leaked", token)).toBe("secret [token] leaked");
  });
});
