// One-job runners RelayRunner creates (pick and machine runners) register on the job's own repo,
// never in an org runner group. A repo runner only ever gets that repo's jobs, and the org's runner
// group settings (which repos, public or not) don't apply to it, so nothing in the customer's org
// has to be set up or changed for it.
//
// GitHub refuses the repo endpoint (a 4xx) when an org installation hasn't accepted Repository
// Administration, or when the org only allows org-level runners. The caller then falls back to the
// installation's own scope (the org), logging it so the gap stays visible.

import { generateJitConfig, type RunnerScope } from "./github-app.ts";

type Runner = Parameters<typeof generateJitConfig>[2];
type Jit = Awaited<ReturnType<typeof generateJitConfig>>;

/** Whether an error from generateJitConfig is GitHub refusing the request (a 4xx). */
export function refusedStatus(error: unknown) {
  const status = (error as { status?: number }).status ?? 0;
  return status >= 400 && status < 500 ? status : null;
}

/**
 * Mints the runner on the job's repo, or, when GitHub refuses that, on the installation's own
 * scope. `beforeFallback` runs first and may throw to stop the fallback (say, a runner group that
 * would never deliver the job). A personal account's refusal is final: its scope was the repo
 * already. Returns the runner and where it registered, which deleting it needs.
 */
export async function mintRepoFirst(
  token: string,
  repo: string,
  runner: Runner,
  options: {
    fallbackScope: () => Promise<RunnerScope>;
    // The fields logged with the fallback, `msg` included.
    log: { msg: string } & Record<string, unknown>;
    beforeFallback?: (scope: RunnerScope) => Promise<void>;
    mint?: typeof generateJitConfig;
  },
): Promise<{ jit: Jit; scope: RunnerScope }> {
  const mint = options.mint ?? generateJitConfig;
  const onRepo: RunnerScope = { kind: "repo", repo };
  try {
    return { jit: await mint(token, onRepo, runner), scope: onRepo };
  } catch (error) {
    const status = refusedStatus(error);
    if (status === null) throw error;
    const scope = await options.fallbackScope();
    if (scope.kind === "repo") throw error;
    console.warn(JSON.stringify({ ...options.log, status, repo }));
    await options.beforeFallback?.(scope);
    return { jit: await mint(token, scope, runner), scope };
  }
}
