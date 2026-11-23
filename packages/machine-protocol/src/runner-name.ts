// The name the gateway gives the one-job runner it mints for a machine. The Rust CLI checks that a
// `run` message's runner ends in its route id (apps/cli/src/jit_config.rs), so keep the route id
// last or every machine starts refusing jobs.

// GitHub runner names allow letters, digits, `.`, `-` and `_`. The machine's name comes first so
// the job's "Runner name" says which machine ran it; the route id keeps it unique in the org. A
// route routed again for a re-run also names its attempt, since the first attempt's runner may
// still be registered if its machine went away mid-job.
export function machineRunnerName(machineName: string, routeId: string, runAttempt?: number) {
  const base =
    machineName
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "machine";
  return `${base}${runAttempt && runAttempt > 1 ? `-${runAttempt}` : ""}-${routeId}`;
}
