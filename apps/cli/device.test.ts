import { describe, expect, test } from "vitest";
import {
  chassisKind,
  cleanChip,
  linuxDevice,
  macDevice,
  macKind,
  macModelFromId,
  osRelease,
  realName,
  type Sources,
} from "./device.ts";

const GB = 1024 * 1024 * 1024;

function sources(
  files: Record<string, string>,
  commands: Record<string, string> = {},
  cpu: Partial<Pick<Sources, "cpuModel" | "cpuCount" | "totalMemory">> = {},
): Sources {
  return {
    read: (path) => files[path] ?? null,
    run: async (command, args) => commands[[command, ...args].join(" ")] ?? null,
    cpuModel: "Apple M3 Pro",
    cpuCount: 12,
    totalMemory: 36 * GB,
    ...cpu,
  };
}

describe("macDevice", () => {
  test("reads the marketing name, chip, cores, memory and macOS version", async () => {
    const mac = sources(
      {},
      {
        "sysctl -n hw.model": "Mac15,9",
        "system_profiler SPHardwareDataType -json": JSON.stringify({
          SPHardwareDataType: [{ machine_name: "MacBook Pro" }],
        }),
        "sysctl -n kern.hv_vmm_present": "0",
        "sw_vers -productVersion": "15.1",
      },
    );
    expect(await macDevice(mac)).toEqual({
      kind: "laptop",
      model: "MacBook Pro",
      modelId: "Mac15,9",
      chip: "Apple M3 Pro",
      cpuCores: 12,
      memoryMb: 36864,
      osVersion: "macOS 15.1",
    });
  });

  test("falls back to the family in hw.model, and reports a macOS VM as one", async () => {
    expect(macModelFromId("Macmini9,1")).toBe("Mac mini");
    expect(macModelFromId("Mac14,13")).toBeUndefined();
    const vm = await macDevice(
      sources({}, { "sysctl -n hw.model": "VirtualMac2,1", "sw_vers -productVersion": "15.1" }),
    );
    expect(vm).toMatchObject({ kind: "vm", modelId: "VirtualMac2,1" });
    expect(vm.model).toBeUndefined();
  });

  test("maps Mac names to kinds", () => {
    expect(macKind("MacBook Air")).toBe("laptop");
    expect(macKind("Mac Studio")).toBe("desktop");
    expect(macKind("Mac mini")).toBe("desktop");
    expect(macKind(undefined)).toBe("unknown");
  });
});

describe("linuxDevice", () => {
  const ubuntu = 'NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\nID=ubuntu\n';

  test("reads a rack server from DMI", async () => {
    const server = sources(
      {
        "/sys/class/dmi/id/sys_vendor": "Dell Inc.",
        "/sys/class/dmi/id/product_name": "PowerEdge R650",
        "/sys/class/dmi/id/chassis_type": "23",
        "/etc/os-release": ubuntu,
        "/proc/cpuinfo": "flags\t\t: fpu vme sse sse2",
      },
      { "systemd-detect-virt --vm": "none" },
      { cpuModel: "Intel(R) Xeon(R) Gold 6338 CPU @ 2.00GHz", cpuCount: 64, totalMemory: 256 * GB },
    );
    expect(await linuxDevice(server)).toEqual({
      kind: "server",
      model: "PowerEdge R650",
      modelId: "PowerEdge R650",
      chip: "Intel Xeon Gold 6338",
      cpuCores: 64,
      memoryMb: 262144,
      osVersion: "Ubuntu 24.04.1 LTS",
    });
  });

  test("uses Lenovo's product_version and skips placeholder names", async () => {
    const thinkpad = await linuxDevice(
      sources({
        "/sys/class/dmi/id/sys_vendor": "LENOVO",
        "/sys/class/dmi/id/product_name": "21HM0029US",
        "/sys/class/dmi/id/product_version": "ThinkPad X1 Carbon Gen 11",
        "/sys/class/dmi/id/chassis_type": "10",
      }),
    );
    expect(thinkpad).toMatchObject({
      kind: "laptop",
      model: "ThinkPad X1 Carbon Gen 11",
      modelId: "21HM0029US",
    });

    const custom = await linuxDevice(
      sources({
        "/sys/class/dmi/id/product_name": "System Product Name",
        "/sys/class/dmi/id/chassis_type": "3",
      }),
    );
    expect(custom).toMatchObject({ kind: "desktop", modelId: "System Product Name" });
    expect(custom.model).toBeUndefined();
  });

  test("reports a VM from systemd, the DMI vendor or the hypervisor flag", async () => {
    const files = { "/sys/class/dmi/id/chassis_type": "1" };
    expect(await linuxDevice(sources(files, { "systemd-detect-virt --vm": "kvm" }))).toMatchObject({
      kind: "vm",
    });
    expect(
      await linuxDevice(sources({ ...files, "/sys/class/dmi/id/sys_vendor": "QEMU" })),
    ).toMatchObject({ kind: "vm" });
    expect(
      await linuxDevice(sources({ ...files, "/proc/cpuinfo": "flags : fpu hypervisor sse" })),
    ).toMatchObject({ kind: "vm" });
    expect(await linuxDevice(sources(files))).toMatchObject({ kind: "unknown" });
  });

  test("names a board from its device tree", async () => {
    const pi = await linuxDevice(
      sources(
        { "/proc/device-tree/model": "Raspberry Pi 4 Model B Rev 1.4" },
        {},
        { cpuModel: "" },
      ),
    );
    expect(pi).toMatchObject({ kind: "unknown", model: "Raspberry Pi 4 Model B Rev 1.4" });
    expect(pi.chip).toBeUndefined();
  });
});

describe("helpers", () => {
  test("chassisKind", () => {
    expect(chassisKind("9")).toBe("laptop");
    expect(chassisKind("35")).toBe("desktop");
    expect(chassisKind("17")).toBe("server");
    expect(chassisKind("2")).toBe("unknown");
    expect(chassisKind(null)).toBe("unknown");
  });

  test("cleanChip", () => {
    expect(cleanChip("AMD EPYC 7543 32-Core Processor")).toBe("AMD EPYC 7543");
    expect(cleanChip("Intel(R) Core(TM) i7-13700")).toBe("Intel Core i7-13700");
    expect(cleanChip("unknown")).toBeUndefined();
  });

  test("realName and osRelease", () => {
    expect(realName("To Be Filled By O.E.M.")).toBeUndefined();
    expect(realName("Standard PC (Q35 + ICH9, 2009)")).toBeUndefined();
    expect(realName("OptiPlex 7010")).toBe("OptiPlex 7010");
    expect(osRelease("PRETTY_NAME='Debian GNU/Linux 12 (bookworm)'")).toBe(
      "Debian GNU/Linux 12 (bookworm)",
    );
    expect(osRelease(null)).toBeUndefined();
  });
});
