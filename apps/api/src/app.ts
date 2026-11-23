import { Hono } from "hono";
import { routePath } from "hono/route";
import { AppError } from "@relayrunner/errors";
import type { AccessIdentity } from "@relayrunner/access";
import type { AgentPrincipal } from "./auth/agent-auth.ts";
import type { Auth, Session } from "./auth/auth.ts";
import type { Db, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import type { Flags } from "@relayrunner/api-types";
import { respondError } from "./errors.ts";
import { requireAccess } from "./middleware/admin.ts";
import { d1Session } from "./middleware/d1-session.ts";
import { withCatalog } from "./providers/provider-catalog.ts";
import { attachSession } from "./middleware/session.ts";
import { activityRoutes } from "./routes/activity.ts";
import { agentRoutes } from "./routes/agents.ts";
import { adminWebhookRoutes } from "./routes/admin-webhooks.ts";
import { adminRoutes } from "./routes/admin.ts";
import { authRoutes } from "./routes/auth.ts";
import { feedbackRoutes } from "./routes/feedback.ts";
import { flagRoutes } from "./routes/flags.ts";
import { telemetryRoutes } from "./routes/telemetry.ts";
import { logBucketRoutes } from "./routes/log-bucket.ts";
import { githubRoutes } from "./routes/github.ts";
import { healthRoutes } from "./routes/health.ts";
import { machineRoutes } from "./routes/machines/index.ts";
import { meRoutes } from "./routes/me.ts";
import { jobTimesRoutes } from "./routes/job-times.ts";
import { signalRoutes } from "./routes/signals.ts";
import { providerRoutes } from "./routes/providers.ts";
import { evaluationRoutes } from "./routes/evaluations.ts";
import { runRoutes } from "./routes/runs.ts";
import { usageRoutes } from "./routes/usage.ts";
import { workspaceRoutes } from "./routes/workspaces.ts";
import { renameSpan } from "./tracing.ts";

export interface AppEnv {
  Bindings: Env;
  Variables: {
    auth: Auth;
    user: Session["user"] | null;
    session: Session["session"] | null;
    // Set by d1Session.
    db: Db;
    workspace: typeof schema.workspace.$inferSelect;
    role: string;
    // Set by requireAccess on /api/admin/*.
    accessIdentity: AccessIdentity;
    // Set by attachSession when the request carries an agent access token (agent-auth.ts).
    agent?: AgentPrincipal;
    // Set by requireMachine on the routes a machine calls with its own token.
    machine: typeof schema.machine.$inferSelect;
    // Flag values already evaluated for this request (src/flags.ts).
    flags?: Partial<Flags>;
  };
}

// Everything lives under /api so the dashboard can call it same-origin.
export const app = new Hono<AppEnv>().basePath("/api");

// Name each request's trace after the route it matched (`GET /api/machines/:id`), so traces group
// by endpoint rather than by URL.
app.use("*", async (c, next) => {
  await next();
  renameSpan(`${c.req.method} ${routePath(c, -1)}`);
});

// Public routes. These never touch auth or D1.
app.route("/health", healthRoutes);
// Operator admin: everything under /api/admin checks the Access JWT (docs/cloudflare-access.md).
// Webhook dead letters need no session or D1, so they work while D1 is down.
app.use("/admin/*", requireAccess);
app.route("/admin/webhooks", adminWebhookRoutes);

// Everything below sees c.var.auth, c.var.user and c.var.session, and the provider list
// (withCatalog).
app.use("*", attachSession, d1Session, withCatalog);
app.route("/auth", authRoutes);
app.route("/me", meRoutes);
app.route("/flags", flagRoutes);
app.route("/workspaces", workspaceRoutes);
app.route("/activity", activityRoutes);
app.route("/usage", usageRoutes);
app.route("/signals", signalRoutes);
app.route("/job-times", jobTimesRoutes);
app.route("/runs", runRoutes);
app.route("/providers", providerRoutes);
app.route("/evaluations", evaluationRoutes);
app.route("/github", githubRoutes);
app.route("/machines", machineRoutes);
app.route("/agents", agentRoutes);
app.route("/feedback", feedbackRoutes);
app.route("/telemetry", telemetryRoutes);
app.route("/log-bucket", logBucketRoutes);
// Operator admin over D1 (users, workspaces, runner prices): Access (above) and an operator
// session.
app.route("/admin", adminRoutes);

app.notFound((c) => respondError(c, new AppError("NOT_FOUND")));
app.onError((error, c) => respondError(c, error));
