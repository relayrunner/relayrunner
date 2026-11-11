/**
 * GitHub webhook ingress. Verifies each delivery, turns it into a compact WebhookMessage and puts it
 * on the `relayrunner-github-webhooks` queue. The API Worker consumes that queue and does the work.
 *
 * This Worker is kept apart from the API so that API deploys, and bugs in processing, never change
 * what GitHub sees: a bad API deploy only makes messages retry (and, past the retry budget, land in
 * the dead letter queue), it never fails a delivery. Keep this file small and boring.
 *
 * Responses, as GitHub's Recent Deliveries shows them:
 * - 200 ping
 * - 202 accepted (queued, or an event RelayRunner doesn't act on)
 * - 401 bad or missing signature
 * - 500 the path's webhook secret can't be read from the Secrets Store
 * - 503 the queue rejected the message; GitHub doesn't retry, so redeliver from the App settings
 */
import {
  toWebhookMessage,
  verifyGitHubSignature,
  type WebhookApp,
  type WebhookMessage,
} from "@relayrunner/github-webhooks";

export interface Env {
  WEBHOOK_QUEUE: Queue<WebhookMessage>;
  // Secrets Store bindings; read with get(). One per GitHub App.
  GITHUB_WEBHOOK_SECRET: SecretsStoreSecret;
  GITHUB_CHECK_WEBHOOK_SECRET: SecretsStoreSecret;
  GITHUB_SPEND_WEBHOOK_SECRET: SecretsStoreSecret;
}

// The paths GitHub posts to, one per App, each signed with that App's own secret and taking only
// the events that App acts on (others get a 202 and are dropped). GitHub sends check_suite to any
// App that can write checks, so the main App would get them too without its list. Messages from
// the Checks App are tagged so the consumer never mistakes them for the main App's. The dashboard
// Worker forwards /api/webhooks/* here over a service binding; this Worker's own workers.dev URL
// and custom domain answer the same paths.
interface Route {
  secret: "GITHUB_WEBHOOK_SECRET" | "GITHUB_CHECK_WEBHOOK_SECRET" | "GITHUB_SPEND_WEBHOOK_SECRET";
  events: ReadonlySet<WebhookMessage["event"]>;
  app?: WebhookApp;
}
const ROUTES: Record<string, Route> = {
  "/api/webhooks/github": {
    secret: "GITHUB_WEBHOOK_SECRET",
    events: new Set([
      "workflow_job",
      "workflow_run",
      "installation",
      "installation_repositories",
      "repository",
      "pull_request",
    ]),
  },
  "/api/webhooks/github-checks": {
    secret: "GITHUB_CHECK_WEBHOOK_SECRET",
    events: new Set(["installation", "installation_repositories", "pull_request", "check_suite"]),
    app: "checks",
  },
  // The Spend App subscribes to no events; GitHub still sends it installation events, which say
  // which orgs installed it.
  "/api/webhooks/github-spend": {
    secret: "GITHUB_SPEND_WEBHOOK_SECRET",
    events: new Set(["installation"]),
    app: "spend",
  },
};

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const route = ROUTES[new URL(request.url).pathname];
  if (!route) return json({ error: "not_found" }, 404);
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const { app } = route;
  const event = request.headers.get("x-github-event") ?? "";
  const deliveryId = request.headers.get("x-github-delivery") ?? "";

  const secret = await readSecret(env[route.secret]);
  if (!secret) {
    log("error", "github webhook secret not configured", { app, event, deliveryId });
    return json({ error: "webhook_secret_not_configured" }, 500);
  }

  const body = await request.text();
  if (!(await verifyGitHubSignature(secret, body, request.headers.get("x-hub-signature-256")))) {
    log("warn", "github webhook signature rejected", { app, event, deliveryId });
    return json({ error: "invalid_signature" }, 401);
  }

  if (event === "ping") {
    log("log", "github webhook received", { app, event, deliveryId });
    return json({ ok: true }, 200);
  }

  let payload: unknown = null;
  try {
    payload = JSON.parse(body);
  } catch {
    // A signed body that isn't JSON: nothing to act on.
  }

  const parsed = toWebhookMessage(event, deliveryId, payload);
  const message = parsed && route.events.has(parsed.event) ? { ...parsed, app } : null;
  const summary = {
    app,
    event,
    deliveryId,
    action: (payload as any)?.action,
    installationId: (payload as any)?.installation?.id,
    repository: (payload as any)?.repository?.full_name,
  };
  if (!message) {
    log("log", "github webhook ignored", summary);
    return new Response(null, { status: 202 });
  }

  try {
    await env.WEBHOOK_QUEUE.send(message);
  } catch (error) {
    log("error", "github webhook enqueue failed", {
      ...summary,
      error: error instanceof Error ? error.message : String(error),
    });
    return json({ error: "enqueue_failed" }, 503);
  }
  log("log", "github webhook queued", summary);
  return new Response(null, { status: 202 });
}

// The binding is missing when wrangler.jsonc doesn't declare it, and get() throws when the store has
// no secret by that name. Both mean "not configured".
async function readSecret(binding: SecretsStoreSecret | undefined) {
  try {
    return binding ? await binding.get() : null;
  } catch {
    return null;
  }
}

function json(body: unknown, status: number) {
  return Response.json(body, { status });
}

function log(level: "log" | "warn" | "error", msg: string, fields: Record<string, unknown>) {
  console[level](JSON.stringify({ msg, ...fields }));
}
