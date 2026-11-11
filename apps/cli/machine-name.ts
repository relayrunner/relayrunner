// The machine name `connect` and `login` suggest on the approval page when --name isn't given.
//
// A hostname someone chose is the best name, so it comes first wherever it's set. macOS usually
// leaves its HostName unset, and os.hostname() then reports something generic like "Mac.local".
// So on a Mac an explicit HostName wins, then the Computer Name from System Settings → General →
// About ("Zach's MacBook Pro"), then the Bonjour LocalHostName. Elsewhere it's the hostname.

import { hostname, platform } from "node:os";
import { run as runCommand, type Run } from "./device.ts";

// The approval page takes names up to 64 characters.
const MAX_LENGTH = 64;

export async function defaultMachineName(
  run: Run = runCommand,
  system: string = platform(),
  host: string = hostname(),
) {
  const names: (string | null)[] = [];
  if (system === "darwin") {
    // scutil exits non-zero ("HostName: not set") when nobody set one, which `run` turns into null.
    for (const key of ["HostName", "ComputerName", "LocalHostName"]) {
      names.push(await run("scutil", ["--get", key]));
    }
  }
  names.push(host.replace(/\.local$/i, ""));
  return (names.find((name) => name?.trim()) ?? "").trim().slice(0, MAX_LENGTH);
}
