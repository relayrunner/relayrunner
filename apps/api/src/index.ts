import { pollActionsUsage } from "./actions-billing.ts";
import { app } from "./app.ts";
import type { WebhookMessage } from "@relayrunner/github-webhooks";
import { checkDeadLetterGrowth } from "./dead-letter-alert.ts";
import { createDb } from "./db/index.ts";
import type { Env } from "./env.ts";
import { purgeOldJobTimings } from "./job-timings.ts";
import { handleWebhookBatch } from "./webhook-queue.ts";

export { ContainerRunner } from "./durable-objects/container-runner.ts";
export { MachineLink } from "./durable-objects/machine-link.ts";
export { PickRunner } from "./durable-objects/pick-runner.ts";
export { Router } from "./durable-objects/router.ts";

// Matches the second entry of triggers.crons in wrangler.jsonc.
const USAGE_CRON = "*/15 * * * *";

// GitHub webhooks arrive on a queue from the ingress Worker (apps/webhooks), not over HTTP.
export default {
  fetch: app.fetch,
  queue: handleWebhookBatch,
  // Every 15 minutes: read each org's Actions usage from GitHub billing (#116). Hourly: alert when
  // webhook dead letters pile up, and drop job timings past retention. Each runs even if another
  // throws; a failure still fails the invocation.
  async scheduled(controller, env) {
    const tasks =
      controller.cron === USAGE_CRON
        ? [pollActionsUsage(env, new Date(controller.scheduledTime))]
        : [checkDeadLetterGrowth(env), purgeOldJobTimings(createDb(env.DB))];
    const results = await Promise.allSettled(tasks);
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  },
} satisfies ExportedHandler<Env, WebhookMessage>;
