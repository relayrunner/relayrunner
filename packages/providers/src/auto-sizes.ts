// The Linux x64 label each provider uses for a runner size, so a relay input of `auto` can ask for
// a size (in vCPUs) rather than a provider's own label. A size the provider doesn't sell rounds up
// to its next one: the size is "at least N vCPUs".
import type { ProviderId } from "./index.ts";

/** The sizes the dashboard offers for a job, in vCPUs. */
export const AUTO_SIZES = [2, 4, 8, 16, 32] as const;
export type AutoSize = (typeof AUTO_SIZES)[number];

export const isAutoSize = (size: number): size is AutoSize =>
  (AUTO_SIZES as readonly number[]).includes(size);

/** What a schema says when a size isn't one of AUTO_SIZES. */
export const AUTO_SIZE_MESSAGE = `Pick a size of ${AUTO_SIZES.join(", ")} vCPU.`;

/** What a job gets when nobody set a size for it or its workspace. */
export const DEFAULT_AUTO_SIZE: AutoSize = 2;

// Each provider's sizes, smallest first, and the label for one.
const LABELS: Partial<
  Record<ProviderId, { sizes: number[]; label: (vcpus: number, runId: number) => string }>
> = {
  blacksmith: {
    sizes: [2, 4, 8, 16, 32],
    label: (n) => `blacksmith-${n}vcpu-ubuntu-2404`,
  },
  depot: {
    sizes: [2, 4, 8, 16, 32, 64],
    label: (n) => (n === 2 ? "depot-ubuntu-24.04" : `depot-ubuntu-24.04-${n}`),
  },
  namespace: {
    sizes: [2, 4, 8, 16, 32],
    label: (n) => `nscloud-ubuntu-24.04-amd64-${n}x${n * 4}`,
  },
  warpbuild: {
    sizes: [2, 4, 8, 16, 32],
    label: (n) => `warp-ubuntu-latest-x64-${n}x`,
  },
  ubicloud: {
    sizes: [2, 4, 8, 16, 30],
    label: (n) => `ubicloud-standard-${n}`,
  },
  // boat-xlarge (16 vCPU) needs Boat's $100 plan and is refused on the $20 one, so auto stops at 8.
  boat: {
    sizes: [2, 4, 8],
    label: (n) => ({ 2: "boat-small", 4: "boat" })[n] ?? "boat-large",
  },
  "runs-on": {
    sizes: [2, 4, 8, 16, 32, 64],
    label: (n, runId) => `runs-on=${runId}/runner=${n}cpu-linux-x64`,
  },
  // The runner clouds below stop at sizes every account can run, since a label the account's
  // plan or settings don't allow sits queued on GitHub.
  // starsling-ubuntu-24.04 with no size is 4 vCPU.
  starsling: {
    sizes: [2, 4, 8, 16, 32, 64],
    label: (n) => (n === 4 ? "starsling-ubuntu-24.04" : `starsling-ubuntu-24.04-${n}`),
  },
  monkci: {
    sizes: [2, 4, 8, 16, 32],
    label: (n) => `monkci-ubuntu-24.04-${n}`,
  },
  // Bigger sizes run once Runloft turns them on for the account.
  runloft: {
    sizes: [2],
    label: () => "runloft-ubuntu-24.04",
  },
  latchkey: {
    sizes: [2, 4, 8, 16],
    label: (n) =>
      ({ 2: "latchkey-small", 4: "latchkey-medium", 8: "latchkey-large" })[n] ?? "latchkey-xlarge",
  },
  berrybox: {
    sizes: [2, 4, 8, 16],
    label: (n) => `berrybox-${n}vcpu-ubuntu-2404`,
  },
  // celesto-micro and -small (1 vCPU) are below the smallest size the dashboard offers.
  celesto: {
    sizes: [2, 4, 8],
    label: (n) => ({ 2: "celesto-standard", 4: "celesto-large" })[n] ?? "celesto-xl",
  },
  // instabox-medium (4 vCPU) is the one size every plan runs, so it also answers 2 vCPU.
  instabox: {
    sizes: [4, 8, 16, 32],
    label: (n) =>
      ({ 4: "instabox-medium", 8: "instabox-large", 16: "instabox-xlarge" })[n] ??
      "instabox-2xlarge",
  },
  lizard: {
    sizes: [2, 4, 8],
    label: (n) => `lizard-${{ 2: "small", 4: "medium" }[n] ?? "large"}-ubuntu-2404`,
  },
  groundbox: {
    sizes: [2, 4, 8, 16],
    label: (n) => `groundbox-${n}vcpu`,
  },
  // GitHub's standard runners. Bigger ones are larger runners each org names itself.
  github: {
    sizes: [1, 2],
    label: (n) => (n === 1 ? "ubuntu-slim" : "ubuntu-latest"),
  },
};

/**
 * The label that gets a provider's smallest runner with at least `vcpus` vCPUs, or null when it
 * has none that big. `runId` is the run's id, which RunsOn labels carry.
 */
export function labelForSize(provider: string, vcpus: number, runId: number): string | null {
  const sized = LABELS[provider as ProviderId];
  const size = sized?.sizes.find((each) => each >= vcpus);
  return sized && size !== undefined ? sized.label(size, runId) : null;
}
