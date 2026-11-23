// The queue the crons hand per-installation work to (src/installation-tasks.ts runs it). A module
// of its own, so the modules that queue work don't import the one that runs it.
import type { UsageAccount } from "./actions-billing.ts";
import type { Env } from "./env.ts";
import type { RunnerScope } from "./github-app.ts";
import type { ProviderSyncTask } from "./provider-sync.ts";

export const INSTALLATION_TASK_QUEUE = "relayrunner-installation-tasks";

export type InstallationTask =
  | { kind: "actions-usage"; account: UsageAccount; at: string }
  // Every org or repo of one installation, so they share its token.
  | { kind: "pick-sweep"; installationId: number; scopes: RunnerScope[] }
  // One connected provider account's usage (src/provider-sync.ts), hourly and after connecting.
  | ProviderSyncTask
  // One installation's last days of signals (src/signals.ts), hourly.
  | { kind: "signals"; installationId: number };

// sendBatch takes at most 100 messages.
const SEND_BATCH = 100;

export async function enqueueInstallationTasks(env: Env, tasks: InstallationTask[]) {
  for (let i = 0; i < tasks.length; i += SEND_BATCH)
    await env.INSTALLATION_TASKS.sendBatch(
      tasks.slice(i, i + SEND_BATCH).map((body) => ({ body })),
    );
}
