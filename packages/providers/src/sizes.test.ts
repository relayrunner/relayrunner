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
    ["namespace", "nscloud-ubuntu-22.04-amd64-4x16", "4 vCPU · 16 GB"],
    ["runs-on", "2cpu-linux-x64", "2 vCPU"],
    ["github", "linux-2-core", "2 vCPU · 8 GB"],
    ["github", "linux-1-core", "1 vCPU · 5 GB"],
    ["github", "ubuntu-24.04-16core", "16 vCPU"],
    ["cloudflare", "standard-1", "0.5 vCPU · 4 GB"],
    ["other", "linux-8-cores", "8 vCPU"],
    ["acme", "acme-32cpu", "32 vCPU"],
  ])("%s %s is %s", (provider, label, text) => {
    expect(sizeText(runnerSize(provider, label))).toBe(text);
  });

  test.each([
    ["namespace", "namespace-profile-default"],
    ["runs-on", "custom"],
    ["github", "macos"],
    ["github", "ubuntu-latest-large"],
    ["ubicloud", "ubicloud-gpu"],
    ["other", "my-runner"],
    ["other", "ubuntu-2404"],
  ])("%s %s has no known size", (provider, label) => {
    expect(runnerSize(provider, label)).toBeNull();
  });
});
