// One `connect` per computer. Two would go online with the same machine token, and each connect
// rotates it, so they'd keep taking over from each other. A menu bar app and a terminal are the
// easy way to end up with two.

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { RunnerError } from "./install.ts";
import { lockHolder, takeLock } from "./job.ts";
import { relayrunnerHome } from "./paths.ts";

/** Takes the lock, or throws ALREADY_CONNECTED. Returns the function that lets it go. */
export function lockConnect(home = relayrunnerHome()) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const lock = join(home, "connect.lock");
  if (!takeLock(lock)) {
    const pid = lockHolder(lock);
    throw new RunnerError(
      "ALREADY_CONNECTED",
      `\`relayrunner connect\` is already running on this computer${pid ? ` (process ${pid})` : ""}. Stop that one first, or use it instead.`,
    );
  }
  return () => {
    // Only our own: a lock taken over after ours went stale belongs to someone else.
    if (lockHolder(lock) === process.pid) rmSync(lock, { force: true });
  };
}
