import { describe, expect, test } from "vitest";
import { labelForSize, runnerSize } from "./index.ts";

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
