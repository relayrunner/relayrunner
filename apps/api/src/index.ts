import { pollActionsUsage } from "./providers/actions-billing.ts";
import { syncEnterpriseInstallations } from "./github/enterprise.ts";
import { syncSpendInstallations } from "./github/spend-app.ts";
import { app } from "./app.ts";
import type { WebhookMessage } from "@relayrunner/github-webhooks";
import { checkDeadLetterGrowth } from "./ingest/dead-letter-alert.ts";
import { createDb } from "./db/index.ts";
import type { Env } from "./env.ts";
import { purgeOldJobTimings } from "./ingest/job-timings.ts";
import { loadCatalog } from "./providers/provider-catalog.ts";
import { sendOperatorPings } from "./operator/operator-pings.ts";
import { sendProductEvents } from "./operator/product-events.ts";
import { checkPrices } from "./providers/price-check.ts";
import { purgeExpiredAiAnswers, purgeOldActivity } from "./ingest/retention.ts";
import { purgeOldWorkflowRuns } from "./reports/runs.ts";
import { releasesToken, syncRunnerReleases } from "./machines/runner-releases.ts";
import { runCronTasks, sendHealthAlerts } from "./operator/health-issues.ts";
import { checkIntegrations, emailWorkspaceAdmins } from "./operator/integration-issues.ts";
import { sweepPicks } from "./routing/pick-sweep.ts";
import { enqueueSignalRollups } from "./reports/signals.ts";
import { sweepProviderHealth } from "./routing/provider-health.ts";
import { purgeOldProviderUsage, syncProviderConnections } from "./providers/provider-sync.ts";
import { handleInstallationTaskBatch } from "./github/installation-tasks.ts";
import { INSTALLATION_TASK_QUEUE, type InstallationTask } from "./github/installation-queue.ts";
import {
  handleTelemetryBatch,
  TELEMETRY_QUEUE,
  type TelemetryMessage,
} from "./telemetry/export.ts";
import { handleJobLogBatch, JOB_LOG_QUEUE, type JobLogMessage } from "./telemetry/logs.ts";
import { handleWebhookBatch } from "./ingest/webhook-queue.ts";
import { wellKnown } from "./auth/well-known.ts";

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
  // track of (src/routing/pick-sweep.ts), check which hosted provider runner types stopped picking up jobs
  // (src/routing/provider-health.ts), and post the
  // window's operator pings to Slack (src/operator/operator-pings.ts) and its product events to PostHog
  // (src/operator/product-events.ts). Hourly: alert when
  // webhook dead letters pile up, drop job timings, workflow runs and Activity rows past retention, reconcile
  // which orgs installed the Spend App (src/github/spend-app.ts) and which enterprises installed the App
  // (src/github/enterprise.ts), and queue a sync of each connected
  // provider account and drop its old usage (src/providers/provider-sync.ts), drop expired cached AI
  // answers (src/ingest/retention.ts), and queue each installation's
  // signals (src/reports/signals.ts), and save new actions/runner releases (src/machines/runner-releases.ts). Daily: check providers' price pages
  // (src/providers/price-check.ts).
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
    // failing reaches operators (src/operator/health-issues.ts).
    await runCronTasks(db, tasks);
  },
} satisfies ExportedHandler<
  Env,
  WebhookMessage | InstallationTask | TelemetryMessage | JobLogMessage
>;
