import { generateJitConfig, type RunnerScope } from "./github-app.ts";
import { mintRepoFirst } from "./repo-runner.ts";
import { machineRunnerName, routeLabel, type Route } from "./routing.ts";

/**
 * Mints the one-job runner a connected machine runs for a route, on the job's own repo
 * (src/repo-runner.ts). GitHub gives every runner its default labels (`self-hosted`, OS, arch), so
 * an org runner would also match any queued `self-hosted` job its runner group allows, from repos
 * that never routed to this machine. A repo runner only ever gets that repo's jobs, and routing has
 * already checked the repo is private. When GitHub refuses the repo, it falls back to the org and
 * logs `machine runner registered on the org`.
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
  const { jit } = await mintRepoFirst(token, route.repo, runner, {
    fallbackScope,
    mint,
    log: {
      msg: "machine runner registered on the org",
      routeId: route.id,
      machineId: route.machineId,
      installationId: route.installationId,
    },
  });
  return jit;
}
