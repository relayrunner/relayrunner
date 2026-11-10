// The name the gateway gives the one-job runner it mints for a machine, and the CLI's check that
// a `run` message's runner is the one minted for that route. Both sides use this one module, so a
// change to the naming can't make every machine start refusing jobs.

// GitHub runner names allow letters, digits, `.`, `-` and `_`. The machine's name comes first so
// the job's "Runner name" says which machine ran it; the route id keeps it unique in the org.
export function machineRunnerName(machineName: string, routeId: string) {
  const base =
    machineName
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "machine";
  return `${base}-${routeId}`;
}

/** Whether `runnerName` is a machineRunnerName() for `routeId`, whatever the machine is called. */
export function isRunnerForRoute(runnerName: string, routeId: string) {
  return runnerName.endsWith(`-${routeId}`);
}
