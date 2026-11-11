// Hosted runner services a job asks for by its `runs-on` labels, and the labels GitHub publishes
// for its own hosted runners. The Job times report and the Runners page group cloud jobs by these.
import { isBlacksmithLabel } from "./routing.ts";

export type CloudProvider = { id: string; name: string; label: string };

// Each service's labels start with its own prefix, e.g. `depot-ubuntu-24.04-8`.
const PREFIXED: { id: string; name: string; matches: (label: string) => boolean }[] = [
  { id: "blacksmith", name: "Blacksmith", matches: isBlacksmithLabel },
  { id: "depot", name: "Depot", matches: (label) => label.startsWith("depot-") },
  {
    id: "namespace",
    name: "Namespace",
    matches: (label) => label.startsWith("namespace-profile-") || label.startsWith("nscloud-"),
  },
  { id: "warpbuild", name: "WarpBuild", matches: (label) => label.startsWith("warp-") },
  {
    id: "ubicloud",
    name: "Ubicloud",
    matches: (label) => label === "ubicloud" || label.startsWith("ubicloud-"),
  },
];

/**
 * The hosted runner service a job's labels ask for, with the label that names its runner type.
 * Labels are lowercase.
 */
export function cloudProviderFor(labels: string[]): CloudProvider | null {
  for (const provider of PREFIXED) {
    const label = labels.find(provider.matches);
    if (label) return { id: provider.id, name: provider.name, label };
  }
  const runsOn = runsOnRunner(labels);
  return runsOn ? { id: "runs-on", name: "RunsOn", label: runsOn } : null;
}

/**
 * RunsOn asks for `runs-on=<run id>/runner=2cpu-linux-x64`, as one label or several. The run id
 * changes every run, so the runner type is the `runner=` or `fleet=` part, else "custom".
 */
function runsOnRunner(labels: string[]): string | null {
  if (!labels.some((label) => label.startsWith("runs-on=") || label.startsWith("runs-on/")))
    return null;
  const parts = labels.flatMap((label) => label.split(/[/,]/));
  for (const key of ["runner=", "fleet="]) {
    const part = parts.find((p) => p.startsWith(key));
    if (part) return part.slice(key.length);
  }
  return "custom";
}

// GitHub's published hosted runner labels: standard images, arm and Intel variants, and the
// larger macOS sizes. Larger Linux and Windows runners take names their owners choose, so those are
// recognised by their runner group instead.
const GITHUB_HOSTED_LABEL =
  /^(ubuntu-(latest|slim|\d{2}\.\d{2}(-arm)?)|windows-(latest|\d{4}(-vs\d{4})?|11(-vs\d{4})?-arm)|macos-(latest|\d+)(-(intel|large|xlarge))?|macos-latest-(large|xlarge)|xcode-\d+)$/;
export const isGitHubHostedLabel = (label: string) => GITHUB_HOSTED_LABEL.test(label);
