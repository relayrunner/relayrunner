import { generateJitConfig, type RunnerScope } from "./github-app.ts";
import { machineRunnerName, routeLabel, type Route } from "./routing.ts";

/**
 * Mints the one-job runner a connected machine runs for a route. It registers on the job's own
 * repo, never the org: GitHub gives every runner its default labels (`self-hosted`, OS, arch), so
 * an org runner would also match any queued `self-hosted` job its runner group allows, from repos
 * that never routed to this machine. A repo runner only ever gets that repo's jobs, and routing has
 * already checked the repo is private.
 *
 * GitHub refuses the repo endpoint (a 4xx) when an org installation hasn't accepted Repository
 * Administration, or when the org only allows org-level runners. Then the runner falls back to the
 * installation's own scope (the org) and the fallback is logged, so routing keeps working while the
 * gap stays visible.
 */
export async function mintMachineRunner(
  token: string,
  route: Pick<Route, "id" | "machineId" | "machineName" | "repo" | "installationId">,
  fallbackScope: () => Promise<RunnerScope>,
  mint: typeof generateJitConfig = generateJitConfig,
) {
  const runner = {
    name: machineRunnerName(route.machineName, route.id),
    labels: [routeLabel(route.id)],
  };
  try {
    return await mint(token, { kind: "repo", repo: route.repo }, runner);
  } catch (error) {
    const status = (error as { status?: number }).status ?? 0;
    if (status < 400 || status >= 500) throw error;
    const scope = await fallbackScope();
    if (scope.kind === "repo") throw error;
    console.warn(
      JSON.stringify({
        msg: "machine runner registered on the org",
        status,
        routeId: route.id,
        machineId: route.machineId,
        repo: route.repo,
        installationId: route.installationId,
      }),
    );
    return mint(token, scope, runner);
  }
}
