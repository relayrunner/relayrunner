// The Router page's sample workspace for the dev preview (lib/sample/answers.ts). `?sample=` on
// the page picks a variant: `enterprise` an org inside a GitHub enterprise, whose minutes can't be
// checked, `personal` a personal account whose owner hasn't signed in, `default` the order a new
// workspace starts with, `no-blacksmith` a workspace that hasn't connected Blacksmith, so its step
// can't stop at the free minutes yet, `no-groundbox` the same for Groundbox,
// `sponsored-groundbox` a Groundbox team on a plan without free minutes, and `boat` (connected) or
// `no-boat` an uncapped Boat step.
import { DEFAULT_RUNNER_ORDER, type FreeMinutesProvider } from "@relayrunner/runner-order";
import type { FreeMinutes } from "../free-minutes.ts";
import { sampleFreeMinutes } from "./free-minutes.ts";
import { sampleConnections } from "./provider-connections.ts";
import type { ProviderSpend } from "../provider-spend.ts";
import type { RunnerOrderResponse } from "../runner-order.ts";
import { sampleParam } from "./param.ts";

export function sampleRunnerOrder(): RunnerOrderResponse {
  const sample = sampleParam();
  if (sample === "default") return { order: DEFAULT_RUNNER_ORDER, isDefault: true };
  if (sample === "boat" || sample === "no-boat")
    return {
      order: { steps: [{ key: "machine" }, { key: "boat" }, { key: "github" }] },
      isDefault: false,
    };
  if (sample === "ph")
    return {
      order: {
        steps: [
          { key: "machine" },
          { key: "github", limit: { percent: 100 } },
          { key: "blacksmith", limit: { percent: 90 } },
          { key: "boat", spendLimit: { usd: 50 } },
        ],
      },
      isDefault: false,
    };
  if (sample === "enterprise" || sample === "personal")
    return { order: { steps: [{ key: "machine" }, { key: "github" }] }, isDefault: false };
  return {
    order: {
      steps: [
        { key: "github", limit: { percent: 80 } },
        { key: "machine" },
        sample === "no-blacksmith"
          ? { key: "blacksmith" }
          : { key: "blacksmith", limit: { percent: 90 } },
        { key: "boat", spendLimit: { usd: 50 } },
        sample === "no-groundbox"
          ? { key: "groundbox" }
          : { key: "groundbox", limit: { percent: 90 } },
        { key: "github" },
      ],
    },
    isDefault: false,
  };
}

export function sampleRouterFreeMinutes(provider: FreeMinutesProvider): FreeMinutes {
  const sample = sampleParam();
  if (provider === "groundbox" && sample === "sponsored-groundbox")
    return {
      ...sampleFreeMinutes("groundbox", true),
      status: "not_available",
      reason: "no_free_minutes",
      plan: "sponsored",
      balanceUsd: 50,
    };
  return sampleFreeMinutes(provider, sample !== `no-${provider}`);
}

/** Depot connected and synced, plus Boat with `?sample=boat`. */
export function sampleRouterConnections() {
  const { connections } = sampleConnections();
  if (sampleParam() !== "boat" && sampleParam() !== "ph") return { connections };
  return {
    connections: connections.map((c) => (c.provider === "boat" ? { ...c, connected: true } : c)),
  };
}

export function sampleProviderSpend(): { spend: ProviderSpend } {
  return {
    spend: {
      boat: sampleParam() === "ph" ? 21.4 : 41.6,
      depot: 12.4,
      blacksmith: 0,
      namespace: 7.25,
      lizard: 3.1,
      warpbuild: 18.9,
      ubicloud: 4.4,
      starsling: 9.75,
      monkci: 22.3,
      runloft: 6.8,
      berrybox: 15.2,
      latchkey: 27.5,
      celesto: 2.05,
      instabox: 11.6,
      groundbox: 5.4,
    },
  };
}
