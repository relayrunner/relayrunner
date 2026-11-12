import { describe, expect, test } from "vitest";
import {
  describeJobPlace,
  describePlace,
  deviceName,
  formatMemory,
  type MachineDevice,
} from "./device.ts";

const device = (parts: Partial<MachineDevice>): MachineDevice => ({
  kind: "unknown",
  model: null,
  modelId: null,
  chip: null,
  cpuCores: null,
  memoryMb: null,
  osVersion: null,
  reportedAt: null,
  ...parts,
});

describe("device badge text", () => {
  test("is the model name, else the kind, else nothing", () => {
    expect(deviceName(device({ kind: "laptop", model: "MacBook Pro" }))).toBe("MacBook Pro");
    expect(deviceName(device({ kind: "vm" }))).toBe("Virtual machine");
    expect(deviceName(device({ model: "Raspberry Pi 4 Model B Rev 1.4" }))).toBe(
      "Raspberry Pi 4 Model B Rev 1.4",
    );
    expect(deviceName(device({}))).toBeNull();
  });

  test("formats memory in whole gigabytes", () => {
    expect(formatMemory(36864)).toBe("36 GB");
    expect(formatMemory(16086)).toBe("16 GB");
    expect(formatMemory(512)).toBe("512 MB");
  });
});

describe("describePlace", () => {
  test("city and country name, either alone, or nothing", () => {
    expect(describePlace("PT", "Lisbon")).toBe("Lisbon, Portugal");
    expect(describePlace("PT", null)).toBe("Portugal");
    expect(describePlace(null, "Lisbon")).toBe("Lisbon");
    expect(describePlace(null, null)).toBeNull();
  });
});

describe("where a machine's jobs run", () => {
  const mac = device({ osVersion: "macOS 27.2" });

  test("a Mac that reports Linux runs each job in a VM", () => {
    expect(describeJobPlace({ os: "linux", device: mac })).toBe("Each in a Linux VM");
  });

  test("a Mac with VM labels takes Linux jobs in a VM and macOS jobs on itself", () => {
    expect(
      describeJobPlace({
        os: "macos",
        device: mac,
        isolatedLabels: ["self-hosted", "Linux", "ARM64"],
      }),
    ).toBe("Linux in a VM · macOS on the Mac");
  });

  test("any other machine runs jobs on itself", () => {
    expect(describeJobPlace({ os: "macos", device: mac })).toBe("On the machine itself");
    expect(
      describeJobPlace({ os: "linux", device: device({ osVersion: "Ubuntu 24.04.1 LTS" }) }),
    ).toBe("On the machine itself");
  });

  test("says nothing when the machine hasn't said what it runs on", () => {
    expect(describeJobPlace({ os: "linux", device: null })).toBeNull();
    expect(describeJobPlace({ os: "linux", device: device({}) })).toBeNull();
    expect(describeJobPlace({ os: null })).toBeNull();
  });
});
