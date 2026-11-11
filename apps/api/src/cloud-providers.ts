// Hosted runner services a job asks for by its `runs-on` labels, and the labels GitHub publishes
// for its own hosted runners. The Job times report and the Runners page group cloud jobs by these.
import { HOSTED_PROVIDER_IDS, isProviderLabel, type ProviderId } from "@relayrunner/providers";

export type CloudProvider = { id: ProviderId; label: string };

/**
 * The hosted runner service a job's labels ask for, with the label that names its runner type.
 * Labels are lowercase.
 */
export function cloudProviderFor(labels: string[]): CloudProvider | null {
  for (const id of HOSTED_PROVIDER_IDS) {
    if (id === "runs-on") continue;
    const label = labels.find((l) => isProviderLabel(id, l));
    if (label) return { id, label };
  }
  const runsOn = runsOnRunner(labels);
  return runsOn ? { id: "runs-on", label: runsOn } : null;
}

/**
 * RunsOn asks for `runs-on=<run id>/runner=2cpu-linux-x64`, as one label or several. The run id
 * changes every run, so the runner type is the `runner=` or `fleet=` part, else "custom".
 */
function runsOnRunner(labels: string[]): string | null {
  if (!labels.some((label) => isProviderLabel("runs-on", label))) return null;
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
