import { pollActionsUsage } from "./actions-billing.ts";
import { syncSpendInstallations } from "./spend-app.ts";
import { app } from "./app.ts";
import type { WebhookMessage } from "@relayrunner/github-webhooks";
import { checkDeadLetterGrowth } from "./dead-letter-alert.ts";
import { createDb } from "./db/index.ts";
import type { Env } from "./env.ts";
import { purgeOldJobTimings } from "./job-timings.ts";
import { checkPrices } from "./price-check.ts";
import { purgeOldWorkflowRuns } from "./runs.ts";
import { sweepPicks } from "./pick-sweep.ts";
import {
  handleInstallationTaskBatch,
  INSTALLATION_TASK_QUEUE,
  type InstallationTask,
} from "./installation-tasks.ts";
import { handleWebhookBatch } from "./webhook-queue.ts";
import { wellKnown } from "./well-known.ts";

export { ContainerRunner } from "./durable-objects/container-runner.ts";
export { LintRunner } from "./durable-objects/lint-runner.ts";
export { MachineLink } from "./durable-objects/machine-link.ts";
export { PickRunner } from "./durable-objects/pick-runner.ts";
export { Router } from "./durable-objects/router.ts";

// Match the second and third entries of triggers.crons in wrangler.jsonc.
const USAGE_CRON = "*/15 * * * *";
const PRICE_CRON = "30 6 * * *";

export default {
  fetch: (request, env, ctx) => wellKnown(request, env) ?? app.fetch(request, env, ctx),
  // GitHub webhooks arrive on a queue from the ingress Worker (apps/webhooks), not over HTTP. The
  // cron's per-installation work arrives on its own queue.
  async queue(batch, env) {
    if (batch.queue === INSTALLATION_TASK_QUEUE)
      return handleInstallationTaskBatch(batch as MessageBatch<InstallationTask>, env);
    return handleWebhookBatch(batch as MessageBatch<WebhookMessage>, env);
  },
  // Every 15 minutes: queue a read of each org's Actions usage from GitHub billing (#116), rescue
  // stuck relay jobs, and queue a sweep for leftover pick runners (src/pick-sweep.ts). Hourly: alert when
  // webhook dead letters pile up, drop job timings and workflow runs past retention, and reconcile
  // which orgs installed the Spend App (src/spend-app.ts). Daily: check
  // providers' price pages (src/price-check.ts). Each runs even if another throws; a failure still
  // fails the invocation.
  async scheduled(controller, env) {
    const at = new Date(controller.scheduledTime);
    const tasks =
      controller.cron === USAGE_CRON
        ? [pollActionsUsage(env, at), sweepPicks(env)]
        : controller.cron === PRICE_CRON
          ? [checkPrices(env, at)]
          : [
              checkDeadLetterGrowth(env),
              purgeOldJobTimings(createDb(env.DB)),
              purgeOldWorkflowRuns(createDb(env.DB)),
              syncSpendInstallations(env, at),
            ];
    const results = await Promise.allSettled(tasks);
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  },
} satisfies ExportedHandler<Env, WebhookMessage | InstallationTask>;
