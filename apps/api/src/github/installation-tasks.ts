/**
 * Per-installation work the crons hand out: reading each account's Actions usage
 * (src/providers/actions-billing.ts), removing leftover pick runners in each org or repo
 * (src/routing/pick-sweep.ts), and, hourly, syncing each connected provider account (src/providers/provider-sync.ts)
 * and working out each installation's signals (src/reports/signals.ts). The cron only lists the installations and queues one message each, so the
 * work spreads over consumer invocations and runs in parallel instead of in one invocation, one
 * installation after another, that grows with every org that connects.
 *
 * Both tasks record or log their own failures and the next cron run repeats them, so a message
 * that still throws is retried once and then dropped (max_retries in wrangler.jsonc), with no DLQ.
 */
import { pollAccount } from "../providers/actions-billing.ts";
import type { Env } from "../env.ts";
import { removeLeftoverRunnersIn } from "../routing/pick-sweep.ts";
import { syncConnection } from "../providers/provider-sync.ts";
import type { InstallationTask } from "./installation-queue.ts";
import { createDb } from "../db/index.ts";
import { syncPullRequestPaths } from "../checks/pull-request-paths.ts";
import { rollUpSignals } from "../reports/signals.ts";
import { classifyJobTypes } from "../ai/job-type.ts";
import { errorMessage } from "../errors.ts";
import { type Outcome, recordOutcomes } from "../operator/health-issues.ts";

export function runInstallationTask(env: Env, task: InstallationTask): Promise<void> {
  switch (task.kind) {
    case "actions-usage":
      return pollAccount(env, task.account, new Date(task.at));
    case "pick-sweep":
      return removeLeftoverRunnersIn(env, task.installationId, task.scopes);
    case "provider-sync":
      return syncConnection(env, task.workspaceId, task.provider);
    case "signals":
      return signals(env, task.installationId);
  }
}

// Pull request files first, so the rollup sees them. Failing to read them never holds it back.
async function signals(env: Env, installationId: number) {
  const db = createDb(env.DB);
  await syncPullRequestPaths(env, db, installationId).catch((error) =>
    console.warn(
      JSON.stringify({
        msg: "pull request files failed",
        installationId,
        error: errorMessage(error),
      }),
    ),
  );
  await rollUpSignals(db, installationId);
  // Only while AI is on for the workspace, and never holding the signals back.
  await classifyJobTypes(env, installationId).catch((error) =>
    console.warn(
      JSON.stringify({ msg: "job types failed", installationId, error: errorMessage(error) }),
    ),
  );
}

/**
 * Handle one batch from the installation task queue. Its messages are separate accounts, so they
 * run together, and each is acked or retried on its own.
 */
export async function handleInstallationTaskBatch(
  batch: MessageBatch<InstallationTask>,
  env: Env,
): Promise<void> {
  const outcomes: Outcome[] = [];
  await Promise.all(
    batch.messages.map(async (msg) => {
      const key = healthKey(msg.body);
      try {
        await runInstallationTask(env, msg.body);
        msg.ack();
        if (key) outcomes.push({ key, kind: "task" });
      } catch (error) {
        if (key) outcomes.push({ key, kind: "task", error });
        console.warn(
          JSON.stringify({
            msg: "installation task failed; retrying",
            kind: msg.body.kind,
            attempts: msg.attempts,
            error: errorMessage(error),
          }),
        );
        msg.retry({ delaySeconds: 60 });
      }
    }),
  );
  // One round trip for the whole batch.
  await recordOutcomes(createDb(env.DB), outcomes);
}

// The health issue a task's failures count toward: one per kind and installation. Usage polls are
// per billing account and already record their failure for the dashboard, so they're left out.
function healthKey(task: InstallationTask) {
  return "installationId" in task ? `task:${task.kind}:${task.installationId}` : null;
}
