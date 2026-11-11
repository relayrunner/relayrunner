import type { Machine } from "./machines.ts";

/** A machine's slots and the jobs it's running, reading an older API's status as one slot. */
export function capacity(status: Machine["status"]) {
  const slots = Math.max(1, status?.slots ?? 1);
  const running = status?.online ? (status.running ?? (status.state === "busy" ? 1 : 0)) : 0;
  return { slots, running, free: !!status?.online && running < slots };
}
