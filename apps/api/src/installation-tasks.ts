/**
 * Per-installation work the 15-minute cron hands out: reading each account's Actions usage
 * (src/actions-billing.ts) and removing leftover pick runners in each org or repo
 * (src/pick-sweep.ts). The cron only lists the installations and queues one message each, so the
 * work spreads over consumer invocations and runs in parallel instead of in one invocation, one
 * installation after another, that grows with every org that connects.
 *
 * Both tasks record or log their own failures and the next cron run repeats them, so a message
 * that still throws is retried once and then dropped (max_retries in wrangler.jsonc), with no DLQ.
 */
import { pollAccount, type UsageAccount } from "./actions-billing.ts";
import type { Env } from "./env.ts";
import type { RunnerScope } from "./github-app.ts";
import { removeLeftoverRunnersIn } from "./pick-sweep.ts";

export const INSTALLATION_TASK_QUEUE = "relayrunner-installation-tasks";

export type InstallationTask =
  | { kind: "actions-usage"; account: UsageAccount; at: string }
  | { kind: "pick-sweep"; installationId: number; scope: RunnerScope };

// sendBatch takes at most 100 messages.
const SEND_BATCH = 100;

export async function enqueueInstallationTasks(env: Env, tasks: InstallationTask[]) {
  for (let i = 0; i < tasks.length; i += SEND_BATCH)
    await env.INSTALLATION_TASKS.sendBatch(
      tasks.slice(i, i + SEND_BATCH).map((body) => ({ body })),
    );
}

export function runInstallationTask(env: Env, task: InstallationTask): Promise<void> {
  switch (task.kind) {
    case "actions-usage":
      return pollAccount(env, task.account, new Date(task.at));
    case "pick-sweep":
      return removeLeftoverRunnersIn(env, task.installationId, task.scope);
  }
}

/** Handle one batch from the installation task queue. Each message is acked or retried on its own. */
export async function handleInstallationTaskBatch(
  batch: MessageBatch<InstallationTask>,
  env: Env,
): Promise<void> {
  for (const msg of batch.messages) {
    try {
      await runInstallationTask(env, msg.body);
      msg.ack();
    } catch (error) {
      console.warn(
        JSON.stringify({
          msg: "installation task failed; retrying",
          kind: msg.body.kind,
          attempts: msg.attempts,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      msg.retry({ delaySeconds: 60 });
    }
  }
}
