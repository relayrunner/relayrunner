// A connected machine's device as its CLI reported it (#165), and how the dashboard names it.
import { sizeText } from "@relayrunner/providers";

export type DeviceKind = "laptop" | "desktop" | "server" | "vm" | "unknown";

/** Each part is null when the CLI couldn't read it. */
export type MachineDevice = {
  kind: DeviceKind;
  /** A display name, such as "MacBook Pro". */
  model: string | null;
  /** The raw identifier it came from, such as "Mac15,9". */
  modelId: string | null;
  chip: string | null;
  cpuCores: number | null;
  memoryMb: number | null;
  /** Such as "macOS 15.1" or "Ubuntu 24.04.1 LTS". */
  osVersion: string | null;
  reportedAt: string | null;
};

const KIND_NAMES: Record<DeviceKind, string | null> = {
  laptop: "Laptop",
  desktop: "Desktop",
  server: "Server",
  vm: "Virtual machine",
  unknown: null,
};

/** The badge's text: the model name, else the kind ("Laptop"), else null for no badge. */
export function deviceName(device: MachineDevice) {
  return device.model ?? KIND_NAMES[device.kind];
}

/** 36864 → "36 GB", 1536 → "1.5 GB"; under a gigabyte stays in MB. */
export function formatMemory(mb: number) {
  if (mb < 1024) return `${mb} MB`;
  const gb = mb / 1024;
  return `${gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10} GB`;
}

/** "Lisbon, Portugal", "Portugal", or the city alone. */
export function describePlace(country: string | null, city: string | null) {
  let countryName = country;
  if (country) {
    try {
      countryName = new Intl.DisplayNames(["en"], { type: "region" }).of(country) ?? country;
    } catch {}
  }
  return [city, countryName].filter(Boolean).join(", ") || null;
}

/**
 * Where a connected machine's jobs run, for its card. A Mac that reports Linux runs each job in a
 * Linux VM, and one that also has VM labels takes macOS jobs on itself. Null when the machine
 * hasn't said what it is, or what it runs on, so the card never claims more than it knows.
 */
export function describeJobPlace(machine: {
  os: string | null;
  isolatedLabels?: string[];
  device?: Pick<MachineDevice, "osVersion"> | null;
  vm?: { cpus: number; memoryGb: number } | null;
}) {
  if (machine.isolatedLabels) return "Linux in a VM · macOS on the Mac";
  const runsOn = machine.device?.osVersion;
  if (!machine.os || !runsOn) return null;
  if (machine.os === "linux" && runsOn.startsWith("macOS")) {
    const size = sizeText(machine.vm && { vcpus: machine.vm.cpus, memoryGb: machine.vm.memoryGb });
    return size ? `Each in a Linux VM · ${size}` : "Each in a Linux VM";
  }
  return "On the machine itself";
}
