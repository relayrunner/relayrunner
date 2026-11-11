import { describe, expect, test } from "vitest";
import { HOSTED_PROVIDER_IDS, hostedProviderOf, isProviderLabel, PROVIDERS } from "./index.ts";

describe("hosted provider labels", () => {
  test("each provider's example label is its own", () => {
    for (const id of HOSTED_PROVIDER_IDS) {
      const example = PROVIDERS[id].example!.replace("${{ github.run_id }}", "123");
      expect(hostedProviderOf(example)).toBe(id);
    }
  });

  test.each([
    ["Blacksmith-4vcpu-ubuntu-2404", "blacksmith"],
    ["nscloud-ubuntu-22.04-amd64-4x8", "namespace"],
    ["ubicloud", "ubicloud"],
    ["runs-on/runner=2cpu-linux-x64", "runs-on"],
    ["ubuntu-latest", null],
    ["self-hosted", null],
  ])("%s belongs to %s", (label, id) => {
    expect(hostedProviderOf(label)).toBe(id);
  });

  test("a label only matches its own provider", () => {
    expect(isProviderLabel("depot", "depot-ubuntu-24.04")).toBe(true);
    expect(isProviderLabel("depot", "warp-ubuntu-latest-x64-2x")).toBe(false);
  });
});
