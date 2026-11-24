/**
 * The API's logger (@relayrunner/log). Every line names an event from API_EVENTS, so a typo fails
 * the typecheck and this list is the catalog of what the API logs. docs/observability.md has the
 * line shape and which events are wide events, the ones dashboards count.
 *
 *   log.info("routing.decision", "job routed", { result: "routed", step: "machine" });
 *
 * Work that spans calls adds its ids once with withLogContext (an entry point) or addLogContext
 * (once they're known), and every line inside carries them.
 */
import { env } from "cloudflare:workers";
import { createLogger, type Level } from "@relayrunner/log";
import type { Env } from "./env.ts";

export { addLogContext, withLogContext } from "@relayrunner/log";

const API_EVENTS = [
  // Wide events: one per unit of work, with every field a chart groups or filters by.
  "routing.decision",
  "webhook.processed",
  "machine.dispatch",
  // API requests (src/app.ts, src/errors.ts).
  "http.request_failed",
  // GitHub webhooks (src/ingest/webhook-queue.ts).
  "webhook.dead_lettered",
  "webhook.dead_letter_not_archived",
  // The Router (src/durable-objects/router.ts).
  "router.requeued",
  "router.machine_skipped",
  "router.owner_access_unknown",
  "router.spillover_not_sent",
  "router.waiting_count_not_sent",
  "github.runners_unavailable",
  "github.apps_unavailable",
  "provider.health_trial",
  "provider.health_changed",
  "provider.repo_trial",
  "provider.repo_missed",
  "provider.repo_recovered",
  // Everything else, by area.
  "admin.dead_letter_discarded",
  "admin.dead_letter_replayed",
  "admin.dead_letters_replayed",
  "admin.price_check_run",
  "admin.user_deleted",
  "admin.user_role_changed",
  "admin.workspace_deleted",
  "ai.call",
  "checks.pr_files_stopped",
  "checks.pr_title_checked",
  "email.no_binding",
  "email.not_rendered",
  "email.operators_not_read",
  "email.send_failed",
  "email.sent",
  "evaluation.cancel_failed",
  "github.enterprise_read_failed",
  "github.membership_sync_skipped",
  "github.rate_limit_read_failed",
  "github.run_history_failed",
  "github.runner_group_check_failed",
  "installation_task.job_types_failed",
  "installation_task.pr_files_failed",
  "installation_task.retrying",
  "machine.connection_taken_over",
  "machine.job",
  "machine.job_not_reached_runner",
  "machine.routing_label_not_removed",
  "machine.run_job_not_read",
  "machine.run_sent",
  "machine.sent_job_not_checked",
  "machine.takeover_not_reported",
  "operator.health_alert_not_posted",
  "operator.health_alerts",
  "operator.health_issues_not_recorded",
  "operator.ping_not_sent",
  "operator.product_events_not_sent",
  "pick.actor_not_found",
  "pick.blocked",
  "pick.check_saving_not_recorded",
  "pick.cleanup_failed",
  "pick.evaluation",
  "pick.gave_up",
  "pick.not_needed",
  "pick.not_recorded",
  "pick.rearmed",
  "provider.actions_billing_not_shared",
  "provider.actions_usage_failed",
  "provider.boat_limits_unreadable",
  "provider.groundbox_unreadable",
  "provider.health_update_failed",
  "provider.price_check",
  "provider.sync_failed",
  "provider.sync_not_queued",
  "retry.annotations_unavailable",
  "retry.cap_reached",
  "retry.decision",
  "runner.poll_message_dropped",
  "stranded.cleanup_failed",
  "stranded.ended",
  "stranded.not_ended",
  "sweep.orphaned_job_ended",
  "sweep.orphaned_job_failed",
  "sweep.orphaned_jobs",
  "sweep.pick_rescued",
  "sweep.pick_runner_removed",
  "sweep.pick_sweep_failed",
  "takeover.checked",
  "takeover.cleanup_failed",
  "takeover.failed",
  "telemetry.batch_failed",
  "telemetry.exports_unreadable",
  "telemetry.job_log_failed",
  "telemetry.job_log_not_queued",
  "telemetry.send_failed",
  "telemetry.spans_not_queued",
  "webhook.dead_letter_alert_not_sent",
  "webhook.dead_letters_rising",
  "webhook.last_error_not_recorded",
  "pick.finished",
  "retry.requested",
  "github.membership_sync_failed",
  "d1_cache.unreadable",
  "flags.evaluation_failed",
  "admin.change",
  "runner.registered_on_org",
  "provider.blacksmith_cli_run",
  "lint.step",
  "container.step",
] as const;

export type ApiEvent = (typeof API_EVENTS)[number];

const LEVELS: readonly string[] = ["debug", "info", "warn", "error"] satisfies Level[];

export const log = createLogger<ApiEvent>(() => {
  // Read on the first line, once the Worker's bindings exist; tests get an empty env.
  const vars = (env ?? {}) as Partial<Env>;
  return {
    service: "api",
    env: vars.LOG_ENV ?? "production",
    version: vars.CF_VERSION_METADATA?.id,
    level: LEVELS.includes(vars.LOG_LEVEL ?? "") ? (vars.LOG_LEVEL as Level) : "info",
    format: vars.LOG_FORMAT === "pretty" ? "pretty" : "json",
  };
});

/**
 * One `machine.dispatch` line: a job handed to a machine, from its `queued` webhook or from the
 * line of jobs waiting for a slot. `error` when sending threw.
 */
export function logDispatch(fields: {
  source: "webhook" | "waiting_line";
  result: "sent" | "already_sent" | "offline" | "wrong_place" | "error";
  routeId: string;
  machineId: string;
  workspaceId: string;
  jobId?: number;
  sendMs?: number;
  waitMs?: number;
  error?: unknown;
}) {
  const { result } = fields;
  if (result === "sent" || result === "already_sent")
    log.info("machine.dispatch", "job sent to machine", fields);
  else if (result === "error") log.error("machine.dispatch", "job not sent to machine", fields);
  else log.warn("machine.dispatch", "job not sent to machine", fields);
}
