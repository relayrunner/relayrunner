import { describe, expect, test } from "vitest";
import { BASE_BOOK, BASE_PRICES, priceBook, rateName } from "./prices.ts";
import { runnerCatalog } from "./runner-catalog.ts";
import { RUNNER_TABLE_ROWS } from "./runner-table.ts";

describe("runnerCatalog", () => {
  test("lists GitHub's larger runners next to its standard ones", () => {
    const rows = runnerCatalog(BASE_BOOK, "github");
    expect(rows.map((row) => row.name)).toEqual([
      "Linux x64",
      "Linux Arm",
      "Windows",
      "Windows Arm",
      "macOS",
      "GPU",
    ]);
    const linux = rows[0]!.runners;
    expect(linux[1]).toMatchObject({
      name: "ubuntu-latest",
      size: { vcpus: 2, memoryGb: 8 },
      usd: 0.006,
      larger: false,
    });
    expect(linux.at(-1)).toMatchObject({
      name: null,
      size: { vcpus: 96, memoryGb: 384 },
      usd: 0.252,
      larger: true,
    });
    expect(rows.flatMap((row) => row.runners)).toHaveLength(32);
  });

  test("prices every runner it lists", () => {
    for (const { id } of RUNNER_TABLE_ROWS)
      for (const row of runnerCatalog(BASE_BOOK, id))
        for (const runner of row.runners) {
          expect(runner.usd, `${id} ${runner.label}`).toBeGreaterThan(0);
          expect(runner.size?.vcpus, `${id} ${runner.label}`).toBeGreaterThan(0);
        }
  });

  test("sizes per-vCPU runners from the label and follows price rows", () => {
    const book = priceBook([
      ...BASE_PRICES,
      { provider: "depot", rate: "linux", usd: 0.004, from: "2026-11-15" },
    ]);
    const linux = runnerCatalog(book, "depot")[0]!.runners;
    expect(linux.map((runner) => runner.size?.vcpus)).toEqual([2, 4, 8, 16, 32, 64]);
    expect(linux[1]).toMatchObject({ label: "depot-ubuntu-24.04-4", usd: 0.016 });
  });

  test("lists Groundbox's one macOS runner, priced per runner", () => {
    const macos = runnerCatalog(BASE_BOOK, "groundbox").find((row) => row.platform === "macos");
    expect(macos?.runners).toEqual([
      {
        label: "groundbox-macos",
        name: "groundbox-macos",
        size: { vcpus: 12, memoryGb: 12 },
        usd: 0.05,
        larger: false,
        note: "M6",
      },
    ]);
    const row = RUNNER_TABLE_ROWS.find((row) => row.id === "groundbox");
    expect(row?.cells.macos).toMatchObject({ label: "groundbox-macos", vcpus: 12, usd: 0.05 });
  });

  test("lists Groundbox's Windows runners, priced per runner", () => {
    const windows = runnerCatalog(BASE_BOOK, "groundbox").find((row) => row.platform === "windows");
    expect(windows?.runners.map((runner) => [runner.label, runner.size, runner.usd])).toEqual([
      ["groundbox-windows-2vcpu", { vcpus: 2, memoryGb: 8 }, 0.006],
      ["groundbox-windows-4vcpu", { vcpus: 4, memoryGb: 16 }, 0.012],
      ["groundbox-windows-8vcpu", { vcpus: 8, memoryGb: 32 }, 0.022],
      ["groundbox-windows-16vcpu", { vcpus: 16, memoryGb: 64 }, 0.042],
    ]);
    const row = RUNNER_TABLE_ROWS.find((row) => row.id === "groundbox");
    expect(row?.cells["windows-16"]).toMatchObject({
      label: "groundbox-windows-16vcpu",
      usd: 0.042,
    });
  });

  test("lists nothing for a provider without list prices", () => {
    expect(runnerCatalog(BASE_BOOK, "namespace")).toEqual([]);
  });
});

test("names GitHub's larger runner rates by size", () => {
  expect(rateName("linux-arm-8-core")).toBe("Linux Arm 8-core");
  expect(rateName("windows-4-core-gpu")).toBe("Windows GPU 4-core");
  expect(rateName("linux-2-core")).toBe("ubuntu-latest");
});
