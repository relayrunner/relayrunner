import { describe, expect, test } from "vitest";
import {
  HOSTED_PROVIDER_IDS,
  hostedProviderOf,
  isProviderLabel,
  PROVIDERS,
  providersOfAppSlugs,
} from "./index.ts";
import { BASE_CATALOG, catalogProviderOf } from "./catalog.ts";

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
    ["starsling-ubuntu-26.04-gpu/gpus=rtx-5090:1", "starsling"],
    ["celesto", "celesto"],
    ["instabox-medium-snapshot-acme-warm", "instabox"],
    ["lizard-large-ubuntu-2404", "lizard"],
    ["groundbox", "groundbox"],
    ["groundbox-4vcpu-ubuntu-2404", "groundbox"],
    ["groundbox-flex-8vcpu", "groundbox"],
    ["groundbox-auto-web", "groundbox"],
    ["ubuntu-latest", null],
    ["self-hosted", null],
  ])("%s belongs to %s", (label, id) => {
    expect(hostedProviderOf(label)).toBe(id);
  });

  test("Boat's labels, with or without options", () => {
    expect(hostedProviderOf("boat")).toBe("boat");
    expect(hostedProviderOf("boat-large/from=ci-base")).toBe("boat");
    expect(hostedProviderOf("boathouse")).toBeNull();
    expect(BASE_CATALOG.find((p) => p.id === "boat")?.prefixes).toEqual(["boat-", "boat/"]);
    expect(catalogProviderOf(BASE_CATALOG, ["boat"])?.id).toBe("boat");
  });

  test("a label only matches its own provider", () => {
    expect(isProviderLabel("depot", "depot-ubuntu-24.04")).toBe(true);
    expect(isProviderLabel("depot", "warp-ubuntu-latest-x64-2x")).toBe(false);
  });
});

describe("provider GitHub Apps", () => {
  test("installed app slugs map to their providers", () => {
    expect(
      providersOfAppSlugs(["blacksmith-sh", "Depot", "runs-on-acme", "relayrunner", "claude"]),
    ).toEqual(["blacksmith", "depot", "runs-on"]);
  });

  test("the runner clouds' own app slugs", () => {
    expect(
      providersOfAppSlugs(["starslingdev", "latchkey-app", "celesto-ci", "instabox", "berrybox"]),
    ).toEqual(["starsling", "latchkey", "berrybox", "celesto", "instabox"]);
  });

  test("no provider apps, no providers", () => {
    expect(providersOfAppSlugs([])).toEqual([]);
    expect(providersOfAppSlugs(["relayrunner", "dependabot"])).toEqual([]);
  });
});
