import { Hono } from "hono";
import type { AccessIdentity } from "@relayrunner/access";
import type { AgentPrincipal } from "./agent-auth.ts";
import type { Auth, Session } from "./auth.ts";
import type { Db, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import { requireAccess } from "./middleware/admin.ts";
import { attachSession } from "./middleware/session.ts";
import { activityRoutes } from "./routes/activity.ts";
import { agentRoutes } from "./routes/agents.ts";
import { adminWebhookRoutes } from "./routes/admin-webhooks.ts";
import { adminRoutes } from "./routes/admin.ts";
import { authRoutes } from "./routes/auth.ts";
import { feedbackRoutes } from "./routes/feedback.ts";
import { githubRoutes } from "./routes/github.ts";
import { healthRoutes } from "./routes/health.ts";
import { inviteRoutes } from "./routes/invites.ts";
import { machineRoutes } from "./routes/machines.ts";
import { meRoutes } from "./routes/me.ts";
import { jobTimesRoutes } from "./routes/job-times.ts";
import { providerRoutes } from "./routes/providers.ts";
import { runRoutes } from "./routes/runs.ts";
import { usageRoutes } from "./routes/usage.ts";
import { workspaceRoutes } from "./routes/workspaces.ts";

export interface AppEnv {
  Bindings: Env;
  Variables: {
    auth: Auth;
    user: Session["user"] | null;
    session: Session["session"] | null;
    // Set by requireWorkspace.
    db: Db;
    workspace: typeof schema.workspace.$inferSelect;
    role: string;
    // Set by requireAccess on /api/admin/*.
    accessIdentity: AccessIdentity;
    // Set by attachSession when the request carries an agent access token (agent-auth.ts).
    agent?: AgentPrincipal;
  };
}

// Everything lives under /api so the dashboard can call it same-origin.
export const app = new Hono<AppEnv>().basePath("/api");

// Public routes. These never touch auth or D1.
app.route("/health", healthRoutes);
// Operator admin: everything under /api/admin checks the Access JWT (docs/cloudflare-access.md).
// Webhook dead letters need no session or D1, so they work while D1 is down.
app.use("/admin/*", requireAccess);
app.route("/admin/webhooks", adminWebhookRoutes);

// Everything below sees c.var.auth, c.var.user and c.var.session.
app.use("*", attachSession);
app.route("/auth", authRoutes);
app.route("/me", meRoutes);
app.route("/workspaces", workspaceRoutes);
app.route("/invites", inviteRoutes);
app.route("/activity", activityRoutes);
app.route("/usage", usageRoutes);
app.route("/job-times", jobTimesRoutes);
app.route("/runs", runRoutes);
app.route("/providers", providerRoutes);
app.route("/github", githubRoutes);
app.route("/machines", machineRoutes);
app.route("/agents", agentRoutes);
app.route("/feedback", feedbackRoutes);
// Operator admin over D1 (users, workspaces): Access (above) and an operator session.
app.route("/admin", adminRoutes);

app.notFound((c) => c.json({ error: "not_found" }, 404));
