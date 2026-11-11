// One copy of the installed runner per job slot, so jobs running at once never share a
// directory: <home>/runner/<version>/slot-<n>/. A new runner version is a new directory, so its
// slots are copied afresh from it.
//
// The copy goes to a temporary directory first and is renamed into place, so a slot that's there
// is complete. It asks for copy-on-write clones (APFS on macOS, btrfs/XFS on Linux) and falls
// back to a plain copy where the filesystem can't clone.

import {
  constants,
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import { basename, join } from "node:path";
import type { InstalledRunner } from "./install.ts";

// The most slots a machine can have; the gateway rejects a hello with more.
export const MAX_SLOTS = 1000;

// 2 slots on a machine with 8 or more cores, otherwise 1.
export function defaultConcurrency(cores = availableParallelism()) {
  return cores >= 8 ? 2 : 1;
}

// The value of `--concurrency`, or the default when it isn't given. Throws on anything but a
// whole number from 1 to MAX_SLOTS.
export function parseConcurrency(value: string | undefined, cores?: number) {
  if (value === undefined || value === "") return defaultConcurrency(cores);
  const n = Number(value);
  if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(n) || n < 1 || n > MAX_SLOTS)
    throw new Error(`--concurrency takes a whole number from 1 to ${MAX_SLOTS}, not "${value}".`);
  return n;
}

export function slotDir(runner: InstalledRunner, slot: number) {
  return join(runner.dir, `slot-${slot}`);
}

// Makes sure slots 1..count exist for this runner version, copying the ones that don't. Returns
// their directories, slot 1 first.
export function ensureSlots(
  runner: InstalledRunner,
  count: number,
  log: (line: string) => void = () => {},
): string[] {
  const dirs: string[] = [];
  const missing: number[] = [];
  for (let slot = 1; slot <= count; slot++) {
    const dir = slotDir(runner, slot);
    dirs.push(dir);
    if (!existsSync(join(dir, "run.sh"))) missing.push(slot);
  }
  if (missing.length > 0)
    log(
      missing.length === 1
        ? `Setting up runner slot ${missing[0]}…`
        : `Setting up ${missing.length} runner slots…`,
    );
  for (const slot of missing) copySlot(runner.dir, slotDir(runner, slot));
  return dirs;
}

// What isn't copied from the installed runner: other slots, half-made copies, and anything a job
// left behind if the install was ever run in place.
const SKIP = /^(slot-\d+|\.slot-.*|_work|_diag|\.runner|\.credentials.*|job\.lock)$/;

function copySlot(source: string, dir: string) {
  // A copy that isn't complete (no run.sh) is replaced.
  rmSync(dir, { recursive: true, force: true });
  const temp = mkdtempSync(join(source, `.${basename(dir)}-`));
  try {
    // Entry by entry: the slots live inside the runner, and cpSync won't copy a directory into
    // itself.
    for (const name of readdirSync(source)) {
      if (SKIP.test(name)) continue;
      cpSync(join(source, name), join(temp, name), {
        recursive: true,
        mode: constants.COPYFILE_FICLONE,
        verbatimSymlinks: true,
        preserveTimestamps: true,
      });
    }
    try {
      renameSync(temp, dir);
    } catch (error) {
      // Another `relayrunner` made the same slot first. Theirs is just as good.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
