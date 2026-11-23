import type { AccessEnv } from "@relayrunner/access";
import type { WebhookMessage } from "@relayrunner/github-webhooks";
import type { BlacksmithSyncer } from "./durable-objects/blacksmith-syncer.ts";
import type { ContainerRunner } from "./durable-objects/container-runner.ts";
import type { LintRunner } from "./durable-objects/lint-runner.ts";
import type { MachineLink } from "./durable-objects/machine-link.ts";
import type { PickRunner } from "./durable-objects/pick-runner.ts";
import type { Router } from "./durable-objects/router.ts";
import type { StrandedJob } from "./durable-objects/stranded-job.ts";
import type { ProviderTakeover } from "./durable-objects/provider-takeover.ts";
import type { InstallationTask } from "./github/installation-queue.ts";
import type { TelemetryMessage } from "./telemetry/export.ts";
import type { JobLogMessage } from "./telemetry/logs.ts";

// Bindings from wrangler.jsonc, plus Worker secrets (`cf workers secrets update`, or .dev.vars locally).
export interface Env extends AccessEnv {
  DB: D1Database;
  // Webhook dead letters (src/ingest/dead-letters.ts), and the queue a replay sends them back to.
  DEAD_LETTERS: R2Bucket;
  WEBHOOK_QUEUE: Queue<WebhookMessage>;
  // Per-installation work the 15-minute cron hands out (src/github/installation-tasks.ts).
  INSTALLATION_TASKS: Queue<InstallationTask>;
  // Finished runs and jobs as spans, on their way to each workspace's OTLP endpoint
  // (src/telemetry/export.ts).
  TELEMETRY_QUEUE: Queue<TelemetryMessage>;
  // Finished jobs whose logs go to their workspace's OTLP endpoint (src/telemetry/logs.ts).
  JOB_LOG_QUEUE: Queue<JobLogMessage>;
  // Alert when more than this many messages are dead-lettered in an hour (src/ingest/dead-letter-alert.ts).
  DEAD_LETTER_ALERT_THRESHOLD?: string;
  // Optional: also POST the alert here (a Slack or Discord incoming webhook), a Worker secret.
  DEAD_LETTER_ALERT_WEBHOOK_URL?: string;
  // Optional: a Slack incoming webhook for operator pings (src/operator/operator-pings.ts): signups, installs,
  // first machines, first machine runs and unroutable runs. A Worker secret.
  OPERATOR_SLACK_WEBHOOK_URL?: string;
  // Test accounts that aren't operators, left out of operator pings: GitHub user ids,
  // comma-separated (wrangler.jsonc vars).
  OPERATOR_PINGS_IGNORE_GITHUB_IDS?: string;
  // PostHog project token for the server-side product events (src/operator/product-events.ts). Public, so
  // it's a wrangler.jsonc var; unset, no events are sent.
  POSTHOG_TOKEN?: string;
  PICK_RUNNER: DurableObjectNamespace<PickRunner>;
  ROUTER: DurableObjectNamespace<Router>;
  MACHINE_LINK: DurableObjectNamespace<MachineLink>;
  // Ends a routed job no machine can take (src/routing/stranded-jobs.ts).
  STRANDED_JOB: DurableObjectNamespace<StrandedJob>;
  PROVIDER_TAKEOVER: DurableObjectNamespace<ProviderTakeover>;
  // Container runners (src/routing/container-runner.ts) and the orgs allowed to start them,
  // comma-separated (unset allows none).
  CONTAINER_RUNNER: DurableObjectNamespace<ContainerRunner>;
  CONTAINER_RUNNER_ORGS?: string;
  // Lint check runs for the Checks App (src/checks/lint-check.ts), one container each. Gated by
  // CONTAINER_RUNNER_ORGS too.
  LINT_RUNNER: DurableObjectNamespace<LintRunner>;
  // Blacksmith's CLI in a container, to read a workspace's Blacksmith usage
  // (src/durable-objects/blacksmith-syncer.ts). Optional so tests run without it.
  BLACKSMITH_SYNCER?: DurableObjectNamespace<BlacksmithSyncer>;

  // Per user and agent grant: caps agent-token requests (middleware/session.ts), from the MCP
  // server or a client calling the API directly. Optional so tests run without it.
  AGENT_LIMITER?: RateLimit;

  // Workers AI, for the decision models in src/ai. Optional so tests and local dev run without
  // it; with no binding every AI call answers "off".
  AI?: Ai;
  // The AI Gateway every model call goes through, for its logs, analytics and limits. The binding
  // is already signed in to the account, so the gateway needs no token.
  AI_GATEWAY_ID: string;
  // Per workspace: caps model calls a minute (src/ai/classify.ts), on top of the daily budgets.
  AI_LIMITER?: RateLimit;

  // Cloudflare Flagship, for feature flags (src/flags.ts). Optional so tests run without it; with
  // no binding every flag is off.
  FLAGS?: Flagship;

  // Cloudflare Email Sending (src/email.ts). Optional so local dev and tests run without it.
  EMAIL?: SendEmail;
  // Sender address on send.relayrunner.app; must be in the binding's allowed_sender_addresses.
  EMAIL_FROM?: string;
  // Optional: the team inbox for operator alerts (dead letters, price checks). Operators can also
  // get their own copy (src/notifications.ts).
  OPERATOR_ALERT_EMAIL?: string;
  // Optional: the team inbox for feedback (routes/feedback.ts). Operators can also get their own copy.
  FEEDBACK_EMAIL?: string;
  // The dashboard origin links in emails point at. Falls back to BETTER_AUTH_URL.
  DASHBOARD_URL?: string;

  BETTER_AUTH_URL: string;
  // The MCP server's URL (apps/agents): the audience agent access tokens are issued for.
  AGENTS_MCP_URL: string;
  BETTER_AUTH_SECRET: string;
  // Comma-separated origin patterns of dashboard previews allowed to sign in (see auth.ts).
  PREVIEW_ORIGINS?: string;
  // Parent domain the session cookie is shared on for hosts under it (see auth.ts).
  SESSION_COOKIE_DOMAIN?: string;
  // The RelayRunner GitHub App's OAuth credentials, used as Better Auth's GitHub provider.
  GITHUB_APP_CLIENT_ID: string;
  GITHUB_APP_CLIENT_SECRET: string;
  // The App's URL slug (github.com/apps/<slug>), for the "Connect GitHub account" install link.
  GITHUB_APP_SLUG: string;
  // The App's numeric ID and its private key (PKCS#8 PEM, from the Secrets Store). Together they
  // sign the App JWTs that mint installation tokens.
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: SecretsStoreSecret;
  // The separate, opt-in RelayRunner Checks App (lint check runs; webhooks arrive tagged
  // app: "checks"): its ID and private key, like the main App's.
  GITHUB_CHECKS_APP_ID: string;
  GITHUB_CHECKS_APP_PRIVATE_KEY: SecretsStoreSecret;
  // The separate, opt-in RelayRunner Spend App, which reads org billing (Organization
  // Administration: read) so the main App doesn't have to. No webhooks.
  GITHUB_SPEND_APP_ID: string;
  GITHUB_SPEND_APP_PRIVATE_KEY: SecretsStoreSecret;
  // AES-256 key (32 bytes, base64) that encrypts the provider tokens workspaces paste
  // (src/providers/provider-tokens.ts), from the Secrets Store. Optional so tests and local dev run without
  // it; connecting a provider fails until it's set.
  PROVIDER_TOKEN_KEY?: SecretsStoreSecret;
}
