import type { Machine } from "./machines.ts";

/**
 * A personal runner takes only its owner's jobs: a machine connected with the Mac app or CLI that
 * its owner hasn't shared. Every other machine, including runners added from GitHub, is shared.
 * Kept apart from lib/machines.ts so modules tested without the API client can use it.
 */
export function isPersonal(machine: Machine) {
  return machine.source !== "github" && machine.sharing === "only_me";
}
