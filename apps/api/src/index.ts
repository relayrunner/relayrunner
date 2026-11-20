import { pollActionsUsage } from "./actions-billing.ts";
import { syncEnterpriseInstallations } from "./enterprise.ts";
import { syncSpendInstallations } from "./spend-app.ts";
import { app } from "./app.ts";
import type { WebhookMessage } from "@relayrunner/github-webhooks";
import { checkDeadLetterGrowth } from "./dead-letter-alert.ts";
import { createDb } from "./db/index.ts";
import type { Env } from "./env.ts";
import { purgeOldJobTimings } from "./job-timings.ts";
import { sendOperatorPings } from "./operator-pings.ts";
import { sendProductEvents } from "./product-events.ts";
import { checkPrices } from "./price-check.ts";
import { purgeExpiredAiAnswers, purgeOldActivity } from "./retention.ts";
import { purgeOldWorkflowRuns } from "./runs.ts";
import { releasesToken, syncRunnerReleases } from "./runner-releases.ts";
import { sweepPicks } from "./pick-sweep.ts";
import { enqueueSignalRollups } from "./signals.ts";
import { sweepProviderHealth } from "./provider-health.ts";
import { purgeOldProviderUsage, syncProviderConnections } from "./provider-sync.ts";
import {
  handleInstallationTaskBatch,
  INSTALLATION_TASK_QUEUE,
  type InstallationTask,
} from "./installation-tasks.ts";
import {
  handleTelemetryBatch,
  TELEMETRY_QUEUE,
  type TelemetryMessage,
} from "./telemetry/export.ts";
import { handleJobLogBatch, JOB_LOG_QUEUE, type JobLogMessage } from "./telemetry/logs.ts";
import { handleWebhookBatch } from "./webhook-queue.ts";
import { wellKnown } from "./well-known.ts";

export { ContainerRunner } from "./durable-objects/container-runner.ts";
export { LintRunner } from "./durable-objects/lint-runner.ts";
export { MachineLink } from "./durable-objects/machine-link.ts";
export { PickRunner } from "./durable-objects/pick-runner.ts";
export { Router } from "./durable-objects/router.ts";
export { StrandedJob } from "./durable-objects/stranded-job.ts";

// Match the second and third entries of triggers.crons in wrangler.jsonc.
const USAGE_CRON = "*/15 * * * *";
const PRICE_CRON = "30 6 * * *";

export default {
  fetch: (request, env, ctx) => wellKnown(request, env) ?? app.fetch(request, env, ctx),
  // GitHub webhooks arrive on a queue from the ingress Worker (apps/webhooks), not over HTTP. The
  // cron's per-installation work, the spans for workspaces' trace exports and the jobs whose logs
  // they export have queues of their own.
  async queue(batch, env) {
    if (batch.queue === INSTALLATION_TASK_QUEUE)
      return handleInstallationTaskBatch(batch as MessageBatch<InstallationTask>, env);
    if (batch.queue === TELEMETRY_QUEUE)
      return handleTelemetryBatch(batch as MessageBatch<TelemetryMessage>, env);
    if (batch.queue === JOB_LOG_QUEUE)
      return handleJobLogBatch(batch as MessageBatch<JobLogMessage>, env);
    return handleWebhookBatch(batch as MessageBatch<WebhookMessage>, env);
  },
  // Every 15 minutes: queue a read of each org's Actions usage from GitHub billing (#116), rescue
  // stuck relay jobs, queue a sweep for leftover pick runners (src/pick-sweep.ts), check which
  // hosted provider runner types stopped picking up jobs (src/provider-health.ts), and post the
  // window's operator pings to Slack (src/operator-pings.ts) and its product events to PostHog
  // (src/product-events.ts). Hourly: alert when
  // webhook dead letters pile up, drop job timings, workflow runs and Activity rows past retention, reconcile
  // which orgs installed the Spend App (src/spend-app.ts) and which enterprises installed the App
  // (src/enterprise.ts), and queue a sync of each connected
  // provider account and drop its old usage (src/provider-sync.ts), drop expired cached AI
  // answers (src/retention.ts), and queue each installation's
  // signals (src/signals.ts), and save new actions/runner releases (src/runner-releases.ts). Daily: check providers' price pages
  // (src/price-check.ts). Each runs even if another throws; a failure still fails the invocation.
  async scheduled(controller, env) {
    const at = new Date(controller.scheduledTime);
    const tasks =
      controller.cron === USAGE_CRON
        ? [
            pollActionsUsage(env, at),
            sweepPicks(env),
            sendOperatorPings(env, at),
            sendProductEvents(env, at),
            sweepProviderHealth(env, at.getTime()),
          ]
        : controller.cron === PRICE_CRON
          ? [checkPrices(env, at)]
          : [
              checkDeadLetterGrowth(env),
              purgeOldJobTimings(createDb(env.DB)),
              purgeOldWorkflowRuns(createDb(env.DB)),
              purgeOldActivity(createDb(env.DB)),
              syncSpendInstallations(env, at),
              syncEnterpriseInstallations(env, createDb(env.DB), at),
              syncProviderConnections(env),
              purgeOldProviderUsage(createDb(env.DB), at),
              purgeExpiredAiAnswers(createDb(env.DB), at.getTime()),
              enqueueSignalRollups(env),
              releasesToken(env, createDb(env.DB)).then((token) =>
                syncRunnerReleases(createDb(env.DB), token),
              ),
            ];
    const results = await Promise.allSettled(tasks);
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  },
} satisfies ExportedHandler<
  Env,
  WebhookMessage | InstallationTask | TelemetryMessage | JobLogMessage
>;
