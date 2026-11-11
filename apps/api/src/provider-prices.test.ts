import { githubRate, listRate, PRICE_CHANGES } from "@relayrunner/providers";
import { describe, expect, test } from "vitest";

describe("list prices", () => {
  test.each([
    ["blacksmith", "blacksmith-4vcpu-ubuntu-2404", 0.008],
    ["blacksmith", "blacksmith-2vcpu-ubuntu-2404-arm", 0.0025],
    ["blacksmith", "blacksmith-8vcpu-windows-2025", 0.032],
    ["depot", "depot-ubuntu-24.04", 0.006],
    ["depot", "depot-ubuntu-24.04-arm-8", 0.024],
    ["depot", "depot-windows-2025", 0.008],
    ["depot", "depot-macos-15", 0.08],
    ["warpbuild", "warp-ubuntu-latest-x64-4x", 0.008],
    ["warpbuild", "warp-ubuntu-latest-arm64-2x", 0.003],
    ["warpbuild", "warp-macos-15-arm64-6x", 0.08],
    ["ubicloud", "ubicloud", 0.00125],
    ["ubicloud", "ubicloud-standard-8-arm", 0.005],
    ["ubicloud", "ubicloud-premium-4", 0.004],
  ] as const)("%s %s costs $%d a minute", (provider, label, rate) => {
    expect(listRate(provider, label)).toBeCloseTo(rate, 6);
  });

  test("labels that don't say their size have no price", () => {
    expect(listRate("namespace", "namespace-profile-default")).toBeNull();
    expect(listRate("runs-on", "2cpu-linux-x64")).toBeNull();
    expect(listRate("ubicloud", "ubicloud-gpu")).toBeNull();
    expect(listRate("github", "ubuntu-latest")).toBeNull();
  });

  test("a job is priced at what a minute cost on the day it ran", () => {
    // Ubicloud's standard 2 vCPU went from $0.001 to $0.00125 on 2026-09-01.
    expect(listRate("ubicloud", "ubicloud", Date.parse("2026-08-31T23:59:59Z"))).toBeCloseTo(
      0.001,
      6,
    );
    expect(listRate("ubicloud", "ubicloud", Date.parse("2026-09-01T00:00:00Z"))).toBeCloseTo(
      0.00125,
      6,
    );
    // Before the oldest known price, that price still holds.
    expect(listRate("ubicloud", "ubicloud", Date.parse("2020-01-01"))).toBeCloseTo(0.0008, 6);
    expect(githubRate("linux-arm-2-core", Date.parse("2020-01-01"))).toBe(0.005);
  });

  test("price changes are listed once each, oldest first", () => {
    expect(PRICE_CHANGES).toContain(Date.parse("2026-09-01T00:00:00Z"));
    expect(PRICE_CHANGES).toEqual([...new Set(PRICE_CHANGES)].sort((a, b) => a - b));
  });
});
