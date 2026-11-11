// Reads what kind of device this machine is and what it runs on, for the `device` field of
// `hello`. The dashboard shows it as a badge ("MacBook Pro") with the specs one hover away.
//
// Everything here is best effort and cheap: each part comes from a file or a quick command, any
// part that can't be read is left out, and nothing here ever throws. A wrong guess only changes
// a badge, so detection never stops a machine from connecting.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { cpus, platform, totalmem } from "node:os";
import type { Device, DeviceKind } from "@relayrunner/machine-protocol";

/** Runs a command and resolves its trimmed stdout, or null when it fails or isn't there. */
export type Run = (command: string, args: string[]) => Promise<string | null>;
/** Reads a file as text, or null when it can't be read. */
export type Read = (path: string) => string | null;

export interface Sources {
  run: Run;
  read: Read;
  /** os.cpus()[0].model, os.cpus().length and os.totalmem(), injectable for tests. */
  cpuModel: string | undefined;
  cpuCount: number;
  totalMemory: number;
}

export const run: Run = (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: 3000, encoding: "utf8" }, (error, stdout) => {
      resolve(error ? null : stdout.trim() || null);
    });
  });

const read: Read = (path) => {
  try {
    // Device-tree strings end in a NUL.
    return readFileSync(path, "utf8").replaceAll("\0", "").trim() || null;
  } catch {
    return null;
  }
};

function defaultSources(): Sources {
  const list = cpus();
  return {
    run,
    read,
    cpuModel: list[0]?.model,
    cpuCount: list.length,
    totalMemory: totalmem(),
  };
}

/** This machine's device, or undefined on a platform it can't read. Never throws. */
export async function detectDevice(
  sources: Sources = defaultSources(),
): Promise<Device | undefined> {
  try {
    const system = platform();
    const found =
      system === "darwin"
        ? await macDevice(sources)
        : system === "linux"
          ? await linuxDevice(sources)
          : undefined;
    return found && compact(found);
  } catch {
    return undefined;
  }
}

/** The specs every platform reads the same way. */
function commonSpecs(sources: Sources) {
  return {
    chip: cleanChip(sources.cpuModel),
    cpuCores: sources.cpuCount > 0 ? sources.cpuCount : undefined,
    memoryMb: sources.totalMemory > 0 ? Math.round(sources.totalMemory / 1024 / 1024) : undefined,
  };
}

export async function macDevice(sources: Sources): Promise<Device> {
  const [modelId, profile, virtual, version] = await Promise.all([
    sources.run("sysctl", ["-n", "hw.model"]),
    sources.run("system_profiler", ["SPHardwareDataType", "-json"]),
    sources.run("sysctl", ["-n", "kern.hv_vmm_present"]),
    sources.run("sw_vers", ["-productVersion"]),
  ]);
  const model = profileModel(profile) ?? macModelFromId(modelId);
  const isVm = virtual === "1" || Boolean(modelId?.startsWith("VirtualMac"));
  return {
    kind: isVm ? "vm" : macKind(model),
    model: isVm ? undefined : model,
    modelId: modelId ?? undefined,
    ...commonSpecs(sources),
    osVersion: version ? `macOS ${version}` : undefined,
  };
}

// system_profiler's "machine_name" is Apple's own marketing name, so no lookup table goes stale.
function profileModel(json: string | null) {
  if (!json) return undefined;
  try {
    const data = JSON.parse(json) as { SPHardwareDataType?: { machine_name?: unknown }[] };
    const name = data.SPHardwareDataType?.[0]?.machine_name;
    return typeof name === "string" && name.trim() ? name.trim() : undefined;
  } catch {
    return undefined;
  }
}

// Older Macs name the family in hw.model ("MacBookPro18,3"). Newer ones say only "Mac15,9".
const MAC_FAMILIES: [prefix: string, name: string][] = [
  ["MacBookPro", "MacBook Pro"],
  ["MacBookAir", "MacBook Air"],
  ["MacBook", "MacBook"],
  ["Macmini", "Mac mini"],
  ["MacPro", "Mac Pro"],
  ["iMacPro", "iMac Pro"],
  ["iMac", "iMac"],
];

export function macModelFromId(modelId: string | null | undefined) {
  if (!modelId) return undefined;
  return MAC_FAMILIES.find(([prefix]) => modelId.startsWith(prefix))?.[1];
}

export function macKind(model: string | undefined): DeviceKind {
  if (!model) return "unknown";
  if (model.startsWith("MacBook")) return "laptop";
  if (/^(iMac|Mac mini|Mac Studio|Mac Pro)/.test(model)) return "desktop";
  return "unknown";
}

export async function linuxDevice(sources: Sources): Promise<Device> {
  const dmi = (name: string) => sources.read(`/sys/class/dmi/id/${name}`);
  const vendor = dmi("sys_vendor");
  const product = dmi("product_name");
  // Lenovo keeps the product code in product_name and the name people know in product_version.
  const lenovoName = vendor?.toUpperCase() === "LENOVO" ? dmi("product_version") : null;
  // Boards without DMI, such as a Raspberry Pi, name themselves in the device tree.
  const boardModel = sources.read("/proc/device-tree/model");
  const rawModel = realName(lenovoName) ?? realName(product) ?? realName(boardModel);

  return {
    kind: (await isLinuxVm(sources, vendor, product)) ? "vm" : chassisKind(dmi("chassis_type")),
    model: rawModel,
    modelId: product ?? boardModel ?? undefined,
    ...commonSpecs(sources),
    osVersion: osRelease(sources.read("/etc/os-release")),
  };
}

const VM_VENDORS = /qemu|kvm|vmware|virtualbox|innotek|xen|bochs|parallels|amazon ec2|google/i;

async function isLinuxVm(sources: Sources, vendor: string | null, product: string | null) {
  // systemd's answer covers the most hypervisors; it prints "none" and exits 1 on bare metal.
  const virt = await sources.run("systemd-detect-virt", ["--vm"]);
  if (virt && virt !== "none") return true;
  if (vendor && VM_VENDORS.test(vendor)) return true;
  if (product && /virtual machine|vmware|virtualbox|kvm|hvm domu/i.test(product)) return true;
  // The CPU flag a hypervisor sets for its guests.
  return /^flags\s*:.*\bhypervisor\b/m.test(sources.read("/proc/cpuinfo") ?? "");
}

// SMBIOS chassis types: https://www.dmtf.org/standards/smbios (System Enclosure, type 3).
const CHASSIS: Record<number, DeviceKind> = {
  3: "desktop",
  4: "desktop",
  5: "desktop",
  6: "desktop",
  7: "desktop",
  8: "laptop",
  9: "laptop",
  10: "laptop",
  13: "desktop",
  14: "laptop",
  15: "desktop",
  16: "desktop",
  17: "server",
  23: "server",
  24: "desktop",
  25: "server",
  28: "server",
  29: "server",
  31: "laptop",
  32: "laptop",
  35: "desktop",
  36: "desktop",
};

export function chassisKind(chassisType: string | null): DeviceKind {
  return CHASSIS[Number(chassisType)] ?? "unknown";
}

// Names firmware fills in when the maker didn't.
const PLACEHOLDERS = [
  /^to be filled by o\.?e\.?m\.?$/i,
  /^system product name$/i,
  /^system version$/i,
  /^default string$/i,
  /^not (specified|applicable)$/i,
  /^o\.?e\.?m\.?$/i,
  /^none$/i,
  /^unknown$/i,
  /^standard pc\b/i,
  /^\d+$/,
];

/** A model name worth showing, or undefined for a placeholder. */
export function realName(name: string | null | undefined) {
  const trimmed = name?.trim();
  if (!trimmed || PLACEHOLDERS.some((pattern) => pattern.test(trimmed))) return undefined;
  return trimmed;
}

/** "Intel(R) Xeon(R) Gold 6338 CPU @ 2.00GHz" → "Intel Xeon Gold 6338". */
export function cleanChip(model: string | undefined) {
  const cleaned = model
    ?.replace(/\((R|TM|C)\)/gi, "")
    .replace(/\s+CPU\s*@.*$/i, "")
    .replace(/\s+@\s*[\d.]+\s*GHz$/i, "")
    .replace(/\s+\d+-Core Processor$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned && cleaned.toLowerCase() !== "unknown" ? cleaned : undefined;
}

/** PRETTY_NAME from /etc/os-release, such as "Ubuntu 24.04.1 LTS". */
export function osRelease(text: string | null) {
  const line = text?.split("\n").find((l) => l.startsWith("PRETTY_NAME="));
  const value = line
    ?.slice("PRETTY_NAME=".length)
    .trim()
    .replace(/^["']|["']$/g, "");
  return value || undefined;
}

// Drops unset parts and trims strings to what the protocol takes.
function compact(device: Device): Device {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(device)) {
    if (value === undefined || value === null || value === "") continue;
    out[key] = typeof value === "string" ? value.slice(0, 120) : value;
  }
  return out as Device;
}
