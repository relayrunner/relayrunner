import { pollActionsUsage } from "./actions-billing.ts";
import { syncEnterpriseInstallations } from "./enterprise.ts";
import { syncSpendInstallations } from "./spend-app.ts";
import { app } from "./app.ts";
import type { WebhookMessage } from "@relayrunner/github-webhooks";
import { checkDeadLetterGrowth } from "./dead-letter-alert.ts";
import { createDb } from "./db/index.ts";
import type { Env } from "./env.ts";
import { purgeOldJobTimings } from "./job-timings.ts";
import { loadCatalog } from "./provider-catalog.ts";
import { sendOperatorPings } from "./operator-pings.ts";
import { sendProductEvents } from "./product-events.ts";
import { checkPrices } from "./price-check.ts";
import { purgeExpiredAiAnswers, purgeOldActivity } from "./retention.ts";
import { purgeOldWorkflowRuns } from "./runs.ts";
import { releasesToken, syncRunnerReleases } from "./runner-releases.ts";
import { runCronTasks, sendHealthAlerts } from "./health-issues.ts";
import { checkIntegrations, emailWorkspaceAdmins } from "./integration-issues.ts";
import { sweepPicks } from "./pick-sweep.ts";
import { enqueueSignalRollups } from "./signals.ts";
import { sweepProviderHealth } from "./provider-health.ts";
import { purgeOldProviderUsage, syncProviderConnections } from "./provider-sync.ts";
import { handleInstallationTaskBatch } from "./installation-tasks.ts";
import { INSTALLATION_TASK_QUEUE, type InstallationTask } from "./installation-queue.ts";
import {
  handleTelemetryBatch,
  TELEMETRY_QUEUE,
  type TelemetryMessage,
} from "./telemetry/export.ts";
import { handleJobLogBatch, JOB_LOG_QUEUE, type JobLogMessage } from "./telemetry/logs.ts";
import { handleWebhookBatch } from "./webhook-queue.ts";
import { wellKnown } from "./well-known.ts";

export { ContainerRunner } from "./durable-objects/container-runner.ts";
export { BlacksmithSyncer } from "./durable-objects/blacksmith-syncer.ts";
export { LintRunner } from "./durable-objects/lint-runner.ts";
export { MachineLink } from "./durable-objects/machine-link.ts";
export { PickRunner } from "./durable-objects/pick-runner.ts";
export { Router } from "./durable-objects/router.ts";
export { StrandedJob } from "./durable-objects/stranded-job.ts";
export { ProviderTakeover } from "./durable-objects/provider-takeover.ts";

// Match the second and third entries of triggers.crons in wrangler.jsonc.
const USAGE_CRON = "*/15 * * * *";
const PRICE_CRON = "30 6 * * *";

export default {
  fetch: (request, env, ctx) => wellKnown(request, env) ?? app.fetch(request, env, ctx),
  // GitHub webhooks arrive on a queue from the ingress Worker (apps/webhooks), not over HTTP. The
  // cron's per-installation work, the spans for workspaces' trace exports and the jobs whose logs
  // they export have queues of their own.
  async queue(batch, env) {
    // Webhooks, signal rollups and trace exports work out jobs' providers (environmentFor), so
    // operator-added providers have to be loaded here too, not only for dashboard routes.
    await loadCatalog(createDb(env.DB));
    if (batch.queue === INSTALLATION_TASK_QUEUE)
      return handleInstallationTaskBatch(batch as MessageBatch<InstallationTask>, env);
    if (batch.queue === TELEMETRY_QUEUE)
      return handleTelemetryBatch(batch as MessageBatch<TelemetryMessage>, env);
    if (batch.queue === JOB_LOG_QUEUE)
      return handleJobLogBatch(batch as MessageBatch<JobLogMessage>, env);
    return handleWebhookBatch(batch as MessageBatch<WebhookMessage>, env);
  },
  // Every 15 minutes: queue a read of each org's Actions usage from GitHub billing (#116), rescue
  // stuck relay jobs, queue a sweep for leftover pick runners, end routed jobs the Router lost
  // track of (src/pick-sweep.ts), check which hosted provider runner types stopped picking up jobs
  // (src/provider-health.ts), and post the
  // window's operator pings to Slack (src/operator-pings.ts) and its product events to PostHog
  // (src/product-events.ts). Hourly: alert when
  // webhook dead letters pile up, drop job timings, workflow runs and Activity rows past retention, reconcile
  // which orgs installed the Spend App (src/spend-app.ts) and which enterprises installed the App
  // (src/enterprise.ts), and queue a sync of each connected
  // provider account and drop its old usage (src/provider-sync.ts), drop expired cached AI
  // answers (src/retention.ts), and queue each installation's
  // signals (src/signals.ts), and save new actions/runner releases (src/runner-releases.ts). Daily: check providers' price pages
  // (src/price-check.ts).
  async scheduled(controller, env) {
    const at = new Date(controller.scheduledTime);
    const db = createDb(env.DB);
    await loadCatalog(db);
    const tasks: Record<string, Promise<unknown>> = controller.cron === USAGE_CRON
      ? {
          pollActionsUsage: pollActionsUsage(env, at),
          sweepPicks: sweepPicks(env),
          sendOperatorPings: sendOperatorPings(env, at),
          sendProductEvents: sendProductEvents(env, at),
          sweepProviderHealth: sweepProviderHealth(env, at.getTime()),
          sendHealthAlerts: sendHealthAlerts(env, at).then((alerts) =>
            emailWorkspaceAdmins(env, db, alerts),
          ),
        }
      : controller.cron === PRICE_CRON
        ? { checkPrices: checkPrices(env, at) }
        : {
            checkDeadLetterGrowth: checkDeadLetterGrowth(env),
            purgeOldJobTimings: purgeOldJobTimings(db),
            purgeOldWorkflowRuns: purgeOldWorkflowRuns(db),
            purgeOldActivity: purgeOldActivity(db),
            syncSpendInstallations: syncSpendInstallations(env, at),
            syncEnterpriseInstallations: syncEnterpriseInstallations(env, db, at),
            syncProviderConnections: syncProviderConnections(env),
            purgeOldProviderUsage: purgeOldProviderUsage(db, at),
            purgeExpiredAiAnswers: purgeExpiredAiAnswers(db, at.getTime()),
            enqueueSignalRollups: enqueueSignalRollups(env),
            checkIntegrations: checkIntegrations(env, db, at),
            syncRunnerReleases: releasesToken(env, db).then((token) =>
              syncRunnerReleases(db, token),
            ),
          };
    // Each runs even if another throws; a failure still fails the invocation, and one that keeps
    // failing reaches operators (src/health-issues.ts).
    await runCronTasks(db, tasks);
  },
} satisfies ExportedHandler<
  Env,
  WebhookMessage | InstallationTask | TelemetryMessage | JobLogMessage
>;
