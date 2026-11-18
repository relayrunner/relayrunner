import { describe, expect, test } from "vitest";
import { runnerSize, sizeText } from "./index.ts";

describe("runnerSize", () => {
  test.each([
    ["blacksmith", "blacksmith-4vcpu-ubuntu-2404", "4 vCPU"],
    ["blacksmith", "blacksmith-6vcpu-macos-15", "6 vCPU"],
    ["depot", "depot-ubuntu-24.04", "2 vCPU"],
    ["depot", "depot-ubuntu-24.04-16", "16 vCPU"],
    ["depot", "depot-macos-15", "8 vCPU"],
    ["warpbuild", "warp-ubuntu-latest-x64-4x", "4 vCPU"],
    ["warpbuild", "warp-ubuntu-2404-x64-16x-spot", "16 vCPU"],
    ["ubicloud", "ubicloud", "2 vCPU"],
    ["ubicloud", "ubicloud-standard-8-arm", "8 vCPU"],
    ["ubicloud", "ubicloud-premium-4-ubuntu-2404", "4 vCPU"],
    ["boat", "boat", "4 vCPU · 8 GB"],
    ["boat", "boat-small", "2 vCPU · 4 GB"],
    ["boat", "boat-xlarge/debug", "16 vCPU · 32 GB"],
    ["namespace", "nscloud-ubuntu-22.04-amd64-4x16", "4 vCPU · 16 GB"],
    ["runs-on", "2cpu-linux-x64", "2 vCPU"],
    ["github", "linux-2-core", "2 vCPU · 8 GB"],
    ["github", "linux-1-core", "1 vCPU · 5 GB"],
    ["github", "ubuntu-24.04-16core", "16 vCPU"],
    ["cloudflare", "standard-1", "0.5 vCPU · 4 GB"],
    ["other", "linux-8-cores", "8 vCPU"],
    ["acme", "acme-32cpu", "32 vCPU"],
    ["starsling", "starsling-ubuntu-24.04", "4 vCPU"],
    ["starsling", "starsling-ubuntu-26.04-16", "16 vCPU"],
    ["monkci", "monkci-ubuntu-24.04-8", "8 vCPU"],
    ["monkci", "monkci-ubuntu-latest", "32 vCPU"],
    ["runloft", "runloft-ubuntu-24.04", "2 vCPU"],
    ["runloft", "runloft-ubuntu-24.04-arm-8cpu", "8 vCPU"],
    ["berrybox", "berrybox-4vcpu-ubuntu-2404", "4 vCPU"],
    ["berrybox", "berrybox-ubuntu-latest", "2 vCPU"],
    ["latchkey", "latchkey-medium", "4 vCPU · 16 GB"],
    ["celesto", "celesto", "1 vCPU · 2 GB"],
    ["celesto", "celesto-large", "4 vCPU · 16 GB"],
    ["instabox", "instabox-medium-snapshot-web", "4 vCPU · 8 GB"],
  ])("%s %s is %s", (provider, label, text) => {
    expect(sizeText(runnerSize(provider, label))).toBe(text);
  });

  test.each([
    ["namespace", "namespace-profile-default"],
    ["runs-on", "custom"],
    ["github", "macos"],
    ["github", "ubuntu-latest-large"],
    ["ubicloud", "ubicloud-gpu"],
    ["boat", "boat-huge"],
    ["other", "my-runner"],
    ["other", "ubuntu-2404"],
  ])("%s %s has no known size", (provider, label) => {
    expect(runnerSize(provider, label)).toBeNull();
  });
});
