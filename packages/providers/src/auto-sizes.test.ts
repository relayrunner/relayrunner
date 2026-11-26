import { describe, expect, test } from "vitest";
import {
  isProviderLabel,
  labelForShape,
  labelForSize,
  runnerSize,
  type ShapePlatform,
  sellsPlatform,
  shapePlatform,
} from "./index.ts";

describe("labelForSize", () => {
  test.each([
    ["blacksmith", 8, "blacksmith-8vcpu-ubuntu-2404"],
    ["depot", 2, "depot-ubuntu-24.04"],
    ["depot", 16, "depot-ubuntu-24.04-16"],
    ["namespace", 4, "nscloud-ubuntu-24.04-amd64-4x16"],
    ["warpbuild", 4, "warp-ubuntu-latest-x64-4x"],
    ["ubicloud", 32, null],
    ["ubicloud", 16, "ubicloud-standard-16"],
    ["boat", 2, "boat-small"],
    ["boat", 4, "boat"],
    ["boat", 8, "boat-large"],
    ["boat", 16, null],
    ["runs-on", 4, "runs-on=7/runner=4cpu-linux-x64"],
    ["starsling", 2, "starsling-ubuntu-24.04-2"],
    ["starsling", 4, "starsling-ubuntu-24.04"],
    ["monkci", 32, "monkci-ubuntu-24.04-32"],
    ["runloft", 2, "runloft-ubuntu-24.04"],
    ["runloft", 4, null],
    ["latchkey", 16, "latchkey-xlarge"],
    ["berrybox", 8, "berrybox-8vcpu-ubuntu-2404"],
    ["celesto", 2, "celesto-standard"],
    ["celesto", 16, null],
    ["instabox", 2, "instabox-medium"],
    ["instabox", 32, "instabox-2xlarge"],
    ["lizard", 2, "lizard-small-ubuntu-2404"],
    ["lizard", 8, "lizard-large-ubuntu-2404"],
    ["lizard", 16, null],
    ["groundbox", 2, "groundbox-2vcpu"],
    ["groundbox", 16, "groundbox-16vcpu"],
    ["groundbox", 32, null],
    ["github", 2, "ubuntu-latest"],
    ["github", 1, "ubuntu-slim"],
    ["github", 4, null],
    ["machine", 2, null],
  ])("%s at %i vCPU is %s", (provider, vcpus, label) => {
    expect(labelForSize(provider, vcpus, 7)).toBe(label);
  });

  test("rounds up to the next size the provider sells", () => {
    expect(labelForSize("ubicloud", 20, 1)).toBe("ubicloud-standard-30");
  });

  test.each([
    "blacksmith",
    "depot",
    "warpbuild",
    "ubicloud",
    "namespace",
    "starsling",
    "monkci",
    "latchkey",
    "berrybox",
    "groundbox",
  ])("%s labels read back as the size they ask for", (provider) => {
    for (const vcpus of [2, 4, 8, 16]) {
      const label = labelForSize(provider, vcpus, 1)!;
      expect(runnerSize(provider, label)?.vcpus).toBe(vcpus);
    }
  });

  test.each(["runloft", "celesto", "instabox"])(
    "%s labels read back at least the size they ask for",
    (provider) => {
      for (const vcpus of [2, 4, 8]) {
        const label = labelForSize(provider, vcpus, 1);
        if (label) expect(runnerSize(provider, label)!.vcpus).toBeGreaterThanOrEqual(vcpus);
      }
    },
  );
});

describe("shapePlatform", () => {
  test.each([
    [undefined, undefined, "linux"],
    ["linux", "arm64", "arm"],
    ["windows", undefined, "windows"],
    ["windows", "arm64", "windows-arm"],
    ["macos", undefined, "macos"],
    ["macos", "arm64", "macos"],
    ["macos", "x64", "macos-intel"],
  ] as const)("os %s, arch %s is %s", (os, arch, platform) => {
    expect(shapePlatform(os, arch)).toBe(platform);
  });
});

describe("labelForShape", () => {
  const runId = 7;
  test.each([
    ["blacksmith", "arm", 4, "blacksmith-4vcpu-ubuntu-2404-arm"],
    ["depot", "arm", 2, "depot-ubuntu-24.04-arm"],
    ["runs-on", "arm", 8, "runs-on=7/runner=8cpu-linux-arm64"],
    ["github", "arm", 2, "ubuntu-24.04-arm"],
    ["github", "arm", 4, null],
    ["warpbuild", "windows", 2, "warp-windows-latest-x64-4x"],
    ["github", "windows", 2, "windows-latest"],
    ["blacksmith", "macos", 2, "blacksmith-6vcpu-macos-latest"],
    ["blacksmith", "macos", 8, null],
    ["depot", "macos", 8, "depot-macos-15"],
    ["github", "macos", 3, "macos-latest"],
    ["github", "macos", 4, null],
    ["ubicloud", "macos", 2, null],
    ["github", "macos-intel", 2, null],
    ["blacksmith", "linux", 8, "blacksmith-8vcpu-ubuntu-2404"],
  ] as const)("%s %s at %i vCPU is %s", (provider, platform, vcpus, label) => {
    expect(labelForShape(provider, platform, vcpus, { runId })).toBe(label);
  });

  test("public repos count GitHub's bigger standard runners", () => {
    expect(labelForShape("github", "linux", 4, { runId, publicRepo: true })).toBe("ubuntu-latest");
    expect(labelForShape("github", "linux", 4, { runId })).toBeNull();
    expect(labelForShape("github", "arm", 4, { runId, publicRepo: true })).toBe("ubuntu-24.04-arm");
    expect(labelForShape("github", "macos", 3, { runId, publicRepo: true })).toBe("macos-latest");
  });

  test("sellsPlatform says whether a provider has the platform at all", () => {
    expect(sellsPlatform("blacksmith", "macos")).toBe(true);
    expect(sellsPlatform("ubicloud", "macos")).toBe(false);
    expect(sellsPlatform("lizard", "linux")).toBe(true);
    expect(sellsPlatform("lizard", "arm")).toBe(false);
  });

  const PLATFORMS: ShapePlatform[] = ["linux", "arm", "windows", "macos"];
  test.each(PLATFORMS)("every %s label is one its provider serves", (platform) => {
    for (const provider of [
      "blacksmith",
      "depot",
      "namespace",
      "warpbuild",
      "ubicloud",
      "boat",
      "runs-on",
      "starsling",
      "monkci",
      "runloft",
      "latchkey",
      "berrybox",
      "celesto",
      "instabox",
      "lizard",
      "groundbox",
    ] as const)
      for (const vcpus of [1, 2, 4, 8, 16, 32, 64]) {
        const label = labelForShape(provider, platform, vcpus, { runId: 1 });
        if (label) expect(isProviderLabel(provider, label), label).toBe(true);
      }
  });

  test.each(["blacksmith", "depot", "warpbuild", "ubicloud"])(
    "%s Arm labels read back as the size they ask for",
    (provider) => {
      for (const vcpus of [2, 4, 8, 16]) {
        const label = labelForShape(provider, "arm", vcpus, { runId: 1 })!;
        expect(runnerSize(provider, label)?.vcpus).toBe(vcpus);
      }
    },
  );
});
