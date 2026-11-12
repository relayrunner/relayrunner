import type { AccessEnv } from "@relayrunner/access";
import type { WebhookMessage } from "@relayrunner/github-webhooks";
import type { ContainerRunner } from "./durable-objects/container-runner.ts";
import type { LintRunner } from "./durable-objects/lint-runner.ts";
import type { MachineLink } from "./durable-objects/machine-link.ts";
import type { PickRunner } from "./durable-objects/pick-runner.ts";
import type { Router } from "./durable-objects/router.ts";
import type { InstallationTask } from "./installation-tasks.ts";

// Bindings from wrangler.jsonc, plus secrets set with `wrangler secret put` (or .dev.vars locally).
export interface Env extends AccessEnv {
  DB: D1Database;
  // Webhook dead letters (src/dead-letters.ts), and the queue a replay sends them back to.
  DEAD_LETTERS: R2Bucket;
  WEBHOOK_QUEUE: Queue<WebhookMessage>;
  // Per-installation work the 15-minute cron hands out (src/installation-tasks.ts).
  INSTALLATION_TASKS: Queue<InstallationTask>;
  // Alert when more than this many messages are dead-lettered in an hour (src/dead-letter-alert.ts).
  DEAD_LETTER_ALERT_THRESHOLD?: string;
  // Optional: also POST the alert here (a Slack or Discord incoming webhook), via `wrangler secret put`.
  DEAD_LETTER_ALERT_WEBHOOK_URL?: string;
  // Optional: a Slack incoming webhook for operator pings (src/operator-pings.ts): signups, installs,
  // first machines, first machine runs and unroutable runs. Set with `wrangler secret put`.
  OPERATOR_SLACK_WEBHOOK_URL?: string;
  PICK_RUNNER: DurableObjectNamespace<PickRunner>;
  ROUTER: DurableObjectNamespace<Router>;
  MACHINE_LINK: DurableObjectNamespace<MachineLink>;
  // Container runners (src/container-runner.ts) and the orgs allowed to start them,
  // comma-separated (unset allows none).
  CONTAINER_RUNNER: DurableObjectNamespace<ContainerRunner>;
  CONTAINER_RUNNER_ORGS?: string;
  // Lint check runs for the Checks App (src/lint-check.ts), one container each. Gated by
  // CONTAINER_RUNNER_ORGS too.
  LINT_RUNNER: DurableObjectNamespace<LintRunner>;

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
}
