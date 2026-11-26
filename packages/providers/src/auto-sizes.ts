// The label each provider uses for a runner of a platform (Linux x64, Linux Arm, Windows, macOS)
// and size, so a relay can ask for a shape (`os`, `arch`, `cpus`, or an input of `auto`) rather
// than a provider's own label. A size the provider doesn't sell rounds up to its next one: the size
// is "at least N vCPUs".
import type { ProviderId } from "./index.ts";

/** The relay's `os` input values. */
export const SHAPE_OSES = ["linux", "macos", "windows"] as const;
export type ShapeOs = (typeof SHAPE_OSES)[number];

/** The relay's `arch` input values. */
export const SHAPE_ARCHES = ["x64", "arm64"] as const;
export type ShapeArch = (typeof SHAPE_ARCHES)[number];

/** A system a hosted runner runs, as a relay's `os` and `arch` pick it. */
export type ShapePlatform = "linux" | "arm" | "windows" | "windows-arm" | "macos" | "macos-intel";

/** Each platform's name, for the Activity page: "Blacksmith has no macOS runner". */
export const SHAPE_PLATFORM_NAMES: Record<ShapePlatform, string> = {
  linux: "Linux x64",
  arm: "Linux Arm",
  windows: "Windows",
  "windows-arm": "Windows Arm",
  macos: "macOS",
  "macos-intel": "Intel macOS",
};

/**
 * The platform hosted providers run a job of this OS and arch on. No OS is Linux. No arch is the
 * OS's standard one: x64 for Linux and Windows, Apple silicon for macOS.
 */
export function shapePlatform(os: ShapeOs = "linux", arch?: ShapeArch): ShapePlatform {
  if (os === "macos") return arch === "x64" ? "macos-intel" : "macos";
  if (os === "windows") return arch === "arm64" ? "windows-arm" : "windows";
  return arch === "arm64" ? "arm" : "linux";
}

/** The sizes the dashboard offers for a job, in vCPUs. */
export const AUTO_SIZES = [2, 4, 8, 16, 32] as const;
export type AutoSize = (typeof AUTO_SIZES)[number];

export const isAutoSize = (size: number): size is AutoSize =>
  (AUTO_SIZES as readonly number[]).includes(size);

/** What a schema says when a size isn't one of AUTO_SIZES. */
export const AUTO_SIZE_MESSAGE = `Pick a size of ${AUTO_SIZES.join(", ")} vCPU.`;

/** What a job gets when nobody set a size for it or its workspace. */
export const DEFAULT_AUTO_SIZE: AutoSize = 2;

interface Sized {
  sizes: number[];
  label: (vcpus: number, runId: number) => string;
}

// Each provider's Linux x64 sizes, smallest first, and the label for one.
const LABELS: Partial<Record<ProviderId, Sized>> = {
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

const UP_TO_16 = [2, 4, 8, 16];
const one = (vcpus: number, label: string): Sized => ({ sizes: [vcpus], label: () => label });

// The other platforms' sizes, for the providers that sell them to every account. macOS runners
// come in one size each. Runloft turns on Arm and Windows per account, so it isn't here.
const OTHER_LABELS: Partial<Record<ShapePlatform, Partial<Record<ProviderId, Sized>>>> = {
  arm: {
    blacksmith: { sizes: UP_TO_16, label: (n) => `blacksmith-${n}vcpu-ubuntu-2404-arm` },
    depot: {
      sizes: UP_TO_16,
      label: (n) => (n === 2 ? "depot-ubuntu-24.04-arm" : `depot-ubuntu-24.04-arm-${n}`),
    },
    warpbuild: { sizes: UP_TO_16, label: (n) => `warp-ubuntu-latest-arm64-${n}x` },
    ubicloud: { sizes: UP_TO_16, label: (n) => `ubicloud-standard-${n}-arm` },
    "runs-on": {
      sizes: [2, 4, 8, 16, 32, 64],
      label: (n, runId) => `runs-on=${runId}/runner=${n}cpu-linux-arm64`,
    },
    github: one(2, "ubuntu-24.04-arm"),
  },
  windows: {
    blacksmith: { sizes: UP_TO_16, label: (n) => `blacksmith-${n}vcpu-windows-2025` },
    depot: {
      sizes: UP_TO_16,
      label: (n) => (n === 2 ? "depot-windows-2025" : `depot-windows-2025-${n}`),
    },
    // WarpBuild's Windows runners start at 4 vCPU.
    warpbuild: { sizes: [4, 8, 16], label: (n) => `warp-windows-latest-x64-${n}x` },
    github: one(2, "windows-latest"),
  },
  macos: {
    blacksmith: one(6, "blacksmith-6vcpu-macos-latest"),
    depot: one(8, "depot-macos-15"),
    warpbuild: one(6, "warp-macos-latest-arm64-6x"),
    groundbox: one(12, "groundbox-macos"),
    github: one(3, "macos-latest"),
  },
};

// GitHub gives public repos bigger standard runners: 4 vCPU on Linux, Linux Arm and Windows.
const GITHUB_PUBLIC: Partial<Record<ShapePlatform, Sized>> = {
  linux: { sizes: [1, 4], label: (n) => (n === 1 ? "ubuntu-slim" : "ubuntu-latest") },
  arm: one(4, "ubuntu-24.04-arm"),
  windows: one(4, "windows-latest"),
};

function sizedFor(provider: string, platform: ShapePlatform, publicRepo: boolean) {
  if (provider === "github" && publicRepo && GITHUB_PUBLIC[platform])
    return GITHUB_PUBLIC[platform];
  const table = platform === "linux" ? LABELS : OTHER_LABELS[platform];
  return table?.[provider as ProviderId];
}

/** Whether a provider sells runners of a platform, at any size. */
export const sellsPlatform = (provider: string, platform: ShapePlatform) =>
  sizedFor(provider, platform, false) !== undefined;

/**
 * The label that gets a provider's smallest runner of a platform with at least `vcpus` vCPUs, or
 * null when it has none that big. `runId` is the run's id, which RunsOn labels carry. A public
 * repo counts GitHub's bigger standard runners.
 */
export function labelForShape(
  provider: string,
  platform: ShapePlatform,
  vcpus: number,
  { runId, publicRepo = false }: { runId: number; publicRepo?: boolean },
): string | null {
  const sized = sizedFor(provider, platform, publicRepo);
  const size = sized?.sizes.find((each) => each >= vcpus);
  return sized && size !== undefined ? sized.label(size, runId) : null;
}

/** The Linux x64 label for a provider's smallest runner with at least `vcpus` vCPUs, or null. */
export const labelForSize = (provider: string, vcpus: number, runId: number) =>
  labelForShape(provider, "linux", vcpus, { runId });
