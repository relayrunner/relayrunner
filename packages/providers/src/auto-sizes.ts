// The Linux x64 label each provider uses for a runner size, so a relay input of `auto` can ask for
// a size (in vCPUs) rather than a provider's own label. A size the provider doesn't sell rounds up
// to its next one: the size is "at least N vCPUs".
import type { ProviderId } from "./index.ts";

/** The sizes the dashboard offers for a job, in vCPUs. */
export const AUTO_SIZES = [2, 4, 8, 16, 32] as const;
export type AutoSize = (typeof AUTO_SIZES)[number];

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
  "runs-on": {
    sizes: [2, 4, 8, 16, 32, 64],
    label: (n, runId) => `runs-on=${runId}/runner=${n}cpu-linux-x64`,
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
