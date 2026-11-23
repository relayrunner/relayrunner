// The runner environment a job ran on (a machine, a GitHub-hosted class, a provider's runner type,
// a self-hosted group), worked out from its labels when a report reads it.
import type { DeviceKind, Environment } from "@relayrunner/api-types";
import { and, inArray } from "drizzle-orm";
import { runnerSize } from "@relayrunner/providers";
import { INSTANCE, usesContainerRunner } from "../routing/container-runner.ts";
import { type Db, schema } from "../db/index.ts";
import { cloudProviderFor, isGitHubHostedLabel } from "../providers/cloud-providers.ts";
import { inWorkspace as machineInWorkspace } from "../machines/machines.ts";
import { currentProviders } from "../providers/provider-catalog.ts";
import { asksForSelfHosted } from "../routing/routing.ts";
import { GITHUB_HOSTED_GROUP, RUNNER_LABELS, runnerClass } from "./runner-rates.ts";

// Adds the size runnerSize finds for a provider's label, when it finds one.
function sized(env: Environment, provider: string, label = env.label): Environment {
  const size = runnerSize(provider, label);
  return size ? { ...env, size } : env;
}

export const MACHINE = "machine:";

// A runner group as GitHub shows it under a runner, or nothing for Default: repo-level runners have
// no group, and GitHub reports them as Default.
const groupDetail = (group: string) =>
  group.toLowerCase() === "default" ? "" : `Runner group: ${group}`;

/**
 * The runner environment a job ran on. Derived when read, like runnerClass, so changing the rules
 * needs no backfill: the window is only a few weeks long.
 */
export function environmentFor(
  labels: string[],
  runnerGroupName: string | null,
  machineId: string | null,
): Environment {
  if (machineId) return { key: `${MACHINE}${machineId}`, label: "Machine", detail: "" };
  if (usesContainerRunner(labels))
    return sized(
      { key: "container", label: "Cloudflare Container", detail: INSTANCE },
      "cloudflare",
      INSTANCE,
    );
  const lower = labels.map((label) => label.toLowerCase());
  // Including the ones operators added in the admin (loaded per request and per queue batch, provider-catalog.ts).
  const provider = cloudProviderFor(lower, currentProviders());
  if (provider)
    return sized(
      { key: `${provider.id}:${provider.label}`, label: provider.label, detail: provider.name },
      provider.id,
    );
  const group = runnerGroupName || "Default";
  // Asked for by name: a `self-hosted` label, a pick, or a route to a machine. GitHub matches group
  // names without case, so `default` and `Default` are one row.
  if (asksForSelfHosted(labels))
    return {
      key: `self-hosted:${group.toLowerCase()}`,
      label: "Self-hosted",
      detail: groupDetail(group),
    };
  if (lower.some(isGitHubHostedLabel) || runnerGroupName === GITHUB_HOSTED_GROUP) {
    const cls = runnerClass(labels, runnerGroupName);
    if (cls !== "other" && cls !== "self-hosted")
      return sized(
        { key: `github:${cls}`, label: RUNNER_LABELS[cls], detail: "GitHub-hosted" },
        "github",
        cls,
      );
    // A larger runner or an image without a standard price: named by its label.
    const label = lower[0] ?? "unknown";
    return sized({ key: `github:${label}`, label, detail: "GitHub-hosted" }, "github");
  }
  // A label nothing above recognises: another service, or a self-hosted runner asked for only by
  // its custom labels.
  const label = lower[0] ?? "unknown";
  return sized(
    {
      key: `other:${label}`,
      label,
      // A runner in an org group is self-hosted, even when nothing knows its labels.
      detail: runnerGroupName
        ? groupDetail(runnerGroupName) || "Self-hosted"
        : "Unrecognized label",
    },
    "other",
  );
}

/** Who runs an environment: `machine`, `github`, `self-hosted`, `container`, a provider's id... */
export const environmentProvider = (env: Environment) => env.key.split(":")[0]!;

/**
 * Names each `machine:<id>` environment from its machine row. A deleted machine keeps its generic
 * name.
 */
export async function nameMachines(db: Db, workspaceId: string, envs: Map<string, Environment>) {
  const machineIds = [...envs.keys()].flatMap((key) =>
    key.startsWith(MACHINE) ? [key.slice(MACHINE.length)] : [],
  );
  if (!machineIds.length) return;
  const machines = await db
    .select({
      id: schema.machine.id,
      name: schema.machine.name,
      source: schema.machine.source,
      kind: schema.machine.deviceKind,
      model: schema.machine.deviceModel,
      chip: schema.machine.chip,
      os: schema.machine.os,
      vmCpus: schema.machine.vmCpus,
      vmMemoryGb: schema.machine.vmMemoryGb,
      isolatedOs: schema.machine.isolatedOs,
    })
    .from(schema.machine)
    .where(and(machineInWorkspace(db, workspaceId), inArray(schema.machine.id, machineIds)));
  for (const machine of machines) {
    const env = envs.get(`${MACHINE}${machine.id}`);
    if (!env) continue;
    env.label = machine.name;
    env.machine = {
      source: machine.source === "github" ? "github" : "connect",
      // Stored only after machine-protocol validated it.
      kind: machine.kind as DeviceKind | null,
      model: machine.model,
    };
    env.detail = [machine.model, machine.chip].filter(Boolean).join(" · ") || (machine.os ?? "");
    // Every job runs in a VM of this size, as of its last connect. With --macos some run on the
    // Mac itself, so the size wouldn't say which.
    if (machine.vmCpus && !machine.isolatedOs)
      env.size = {
        vcpus: machine.vmCpus,
        ...(machine.vmMemoryGb && { memoryGb: machine.vmMemoryGb }),
      };
  }
}
