import { describe, expect, test } from "vitest";
import { describePlace, deviceName, formatMemory, type MachineDevice } from "./device.ts";

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
