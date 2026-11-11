import { describe, expect, test } from "vitest";
import { defaultMachineName } from "./machine-name.ts";
import type { Run } from "./device.ts";

const commands =
  (outputs: Record<string, string>): Run =>
  async (command, args) =>
    outputs[[command, ...args].join(" ")] ?? null;

describe("defaultMachineName", () => {
  test("uses a Mac's HostName when someone set one", async () => {
    const run = commands({
      "scutil --get HostName": "m3p0",
      "scutil --get ComputerName": "Zach's MacBook Pro",
    });
    expect(await defaultMachineName(run, "darwin", "m3p0")).toBe("m3p0");
  });

  test("uses the Computer Name when the HostName isn't set", async () => {
    const run = commands({
      "scutil --get ComputerName": "Zach's MacBook Pro",
      "scutil --get LocalHostName": "Zachs-MacBook-Pro",
    });
    expect(await defaultMachineName(run, "darwin", "Mac.local")).toBe("Zach's MacBook Pro");
  });

  test("falls back to the LocalHostName, then the hostname without .local", async () => {
    const localOnly = commands({ "scutil --get LocalHostName": "Zachs-MacBook-Pro" });
    expect(await defaultMachineName(localOnly, "darwin", "Mac.local")).toBe("Zachs-MacBook-Pro");
    expect(await defaultMachineName(commands({}), "darwin", "Mac.local")).toBe("Mac");
  });

  test("uses the hostname on Linux without asking scutil", async () => {
    const run: Run = async () => {
      throw new Error("scutil isn't on Linux");
    };
    expect(await defaultMachineName(run, "linux", "build-box")).toBe("build-box");
  });

  test("keeps the name within what the approval page takes", async () => {
    const run = commands({ "scutil --get ComputerName": "x".repeat(100) });
    expect(await defaultMachineName(run, "darwin", "Mac.local")).toHaveLength(64);
  });
});
