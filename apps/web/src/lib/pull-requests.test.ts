import { minuteBuckets, type PullRequestMinutes } from "@relayrunner/api-types";
import { describe, expect, test } from "vitest";
import { bucketPosition, stateOf } from "./pull-requests";

const pr: PullRequestMinutes = {
  repository: "acme/app",
  number: 1,
  title: null,
  minutes: 1,
  rerunMinutes: 0,
  cost: 0.006,
  commits: 1,
  openedAt: null,
  mergedAt: null,
  closedAt: null,
  firstRunAt: 100,
};

describe("pull request minute bars", () => {
  test("places a value across the bars", () => {
    const buckets = minuteBuckets([3, 4, 8, 12, 14, 18, 25, 40, 70, 400]);
    expect(bucketPosition(buckets, 15)).toBe(1.5);
    expect(bucketPosition(buckets, 500)).toBe(7.5);
  });
});

describe("pull request state", () => {
  test("says whether it merged or closed", () => {
    expect(stateOf(pr)).toBe("open");
    expect(stateOf({ ...pr, mergedAt: 3, closedAt: 3 })).toBe("merged");
    expect(stateOf({ ...pr, closedAt: 3 })).toBe("closed");
  });
});
