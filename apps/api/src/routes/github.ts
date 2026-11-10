import { and, eq, inArray, isNull } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../app.ts";
import { createDb, schema } from "../db/index.ts";
import { appJwt, importAppPrivateKey, installationToken, rateLimits } from "../github-app.ts";
import {
  dashboardPath,
  GitHubError,
  installUrl,
  installationSettingsUrl,
  listUserInstallations,
  signInstallState,
  verifyInstallState,
} from "../github.ts";
import {
  findInstallation,
  isWorkspaceMember,
  linkInstallation,
  upsertInstallation,
  userGitHubToken,
} from "../installations.ts";
import { requireUser } from "../middleware/session.ts";
import { requireWorkspace } from "../middleware/workspace.ts";
import { canManage, requireManager } from "../roles.ts";

// Connecting GitHub orgs (GitHub App installations) to workspaces.
//
// 1. The dashboard's "Connect GitHub account" links to GET /install, which sends the user to the App's
//    install page with a signed `state` naming the active workspace.
// 2. GitHub sends them back to the App's Setup URL, GET /setup, with `installation_id`. That id
//    comes from a query string, so it only counts if the user's own GitHub token can see it in
//    GET /user/installations. Then the installation is linked to the workspace from `state`.
//    /install takes an optional `?next=<dashboard path>` that rides in the signed state, so /setup
//    can send the browser back there (the /device page while `relayrunner connect` onboards a new
//    user) instead of /settings/github. The state also carries the origin /install ran on, and
//    /setup hands the request back there when GitHub's fixed Setup URL is another host.
// 3. Installs made straight on GitHub arrive with no `state` (or by webhook only) and stay
//    unclaimed. The dashboard lists the user's unclaimed ones (GET /installations/unclaimed) and
//    claims one into the active workspace (POST /installations/:id/claim), with the same check.
//
// An installation belongs to at most one workspace; linking one that another workspace holds is
// refused.

// Where /setup sends the browser, with ?github=<outcome> for the dashboard to explain.
type SetupOutcome =
  | "connected"
  | "updated"
  | "unclaimed"
  | "requested"
  | "taken"
  | "not_found"
  | "expired"
  | "reauth"
  | "invalid";

export const githubRoutes = new Hono<AppEnv>()
  .get("/install", requireUser, requireWorkspace, requireManager, async (c) => {
    if (!c.env.GITHUB_APP_SLUG) return c.json({ error: "github_app_slug_not_configured" }, 500);
    const state = await signInstallState(
      c.env.BETTER_AUTH_SECRET,
      c.var.workspace.id,
      c.var.user!.id,
      { next: dashboardPath(c.req.query("next")), origin: new URL(c.req.url).origin },
    );
    return c.redirect(installUrl(c.env.GITHUB_APP_SLUG, state));
  })

  .get("/setup", async (c) => {
    // The state is read up front only for where to land afterwards; whether it may link anything
    // is checked against the signed-in user below.
    const stateParam = c.req.query("state");
    const state = stateParam
      ? await verifyInstallState(c.env.BETTER_AUTH_SECRET, stateParam)
      : null;
    // GitHub's Setup URL is one fixed host, but the install may have started on another (the
    // workers.dev host `relayrunner connect` links to, a preview, or the custom domain), and the
    // session cookie only lives there. Hand the request back to that origin first, or this
    // host sees no session. The origin rides in the signed state, so this isn't an open redirect.
    const here = new URL(c.req.url);
    if (state?.origin && state.origin !== here.origin)
      return c.redirect(`${state.origin}${here.pathname}${here.search}`);
    const landing = state?.next ?? "/settings/github";
    const done = (outcome: SetupOutcome) => {
      const url = new URL(landing, "https://dashboard.invalid");
      url.searchParams.set("github", outcome);
      return c.redirect(`${url.pathname}${url.search}`);
    };
    // An org member without admin asked an owner to approve the install. Nothing to link yet; the
    // installation webhook records it once approved.
    if (c.req.query("setup_action") === "request") return done("requested");

    const user = c.var.user;
    // Signed out (or the session expired on the way): the installation is recorded by webhook and
    // shows up to claim after sign-in.
    if (!user)
      return c.redirect(
        `/login?redirect=${encodeURIComponent(state?.next ?? "/settings/github?github=unclaimed")}`,
      );

    const installationId = Number(c.req.query("installation_id"));
    if (!Number.isSafeInteger(installationId) || installationId <= 0) return done("invalid");

    const db = createDb(c.env.DB);
    const verified = await verifiedInstallation(c, installationId);
    if (verified === "reauth") return done("reauth");
    if (!verified) return done("not_found");
    await upsertInstallation(db, verified);

    if (stateParam) {
      // A stale or someone else's link: keep the installation, unclaimed, for the user to claim.
      if (!state || state.userId !== user.id) return done("expired");
      const membership = await isWorkspaceMember(db, state.workspaceId, user.id);
      if (!membership || !canManage(membership.role)) return done("expired");
      const result = await linkInstallation(db, installationId, state.workspaceId);
      return done(result === "taken" ? "taken" : "connected");
    }

    // No state: installed straight from GitHub, or "Redirect on update" after changing the
    // installation's repos or permissions.
    const row = await findInstallation(db, installationId);
    if (!row?.workspaceId) return done("unclaimed");
    return done((await isWorkspaceMember(db, row.workspaceId, user.id)) ? "updated" : "taken");
  })

  .get("/installations/unclaimed", requireUser, async (c) => {
    const db = createDb(c.env.DB);
    const token = await userGitHubToken(c.var.auth, db, c.var.user!.id);
    if (!token) return c.json({ error: "github_reauth" }, 409);
    const visible = await listOrReauth(token);
    if (visible === "reauth") return c.json({ error: "github_reauth" }, 409);
    // Catch up on installs whose webhook we missed (or that predate the webhook handler).
    for (const installation of visible) await upsertInstallation(db, installation);
    if (!visible.length) return c.json({ installations: [] });

    const rows = await db
      .select()
      .from(schema.githubInstallation)
      .where(
        and(
          inArray(
            schema.githubInstallation.id,
            visible.map((installation) => installation.id),
          ),
          isNull(schema.githubInstallation.workspaceId),
        ),
      )
      .orderBy(schema.githubInstallation.accountLogin);
    return c.json({ installations: rows.map(present) });
  })

  .post("/installations/:id/claim", requireUser, requireWorkspace, requireManager, async (c) => {
    const installationId = Number(c.req.param("id"));
    if (!Number.isSafeInteger(installationId) || installationId <= 0)
      return c.json({ error: "not_found" }, 404);

    const verified = await verifiedInstallation(c, installationId);
    if (verified === "reauth") return c.json({ error: "github_reauth" }, 409);
    if (!verified) return c.json({ error: "not_found" }, 404);
    await upsertInstallation(c.var.db, verified);

    if ((await linkInstallation(c.var.db, installationId, c.var.workspace.id)) === "taken") {
      return c.json({ error: "installation_in_another_workspace" }, 409);
    }
    return c.json({ ok: true });
  })

  // How much of the installation's GitHub API quota the App has used this hour (#166). Read live
  // from GitHub on each call; nothing is stored. Any member of the owning workspace can see it.
  .get("/installations/:id/rate-limit", requireUser, requireWorkspace, async (c) => {
    const installationId = Number(c.req.param("id"));
    if (!Number.isSafeInteger(installationId) || installationId <= 0)
      return c.json({ error: "not_found" }, 404);
    const [row] = await c.var.db
      .select({ id: schema.githubInstallation.id })
      .from(schema.githubInstallation)
      .where(
        and(
          eq(schema.githubInstallation.id, installationId),
          eq(schema.githubInstallation.workspaceId, c.var.workspace.id),
        ),
      )
      .limit(1);
    if (!row) return c.json({ error: "not_found" }, 404);

    try {
      const key = await importAppPrivateKey(await c.env.GITHUB_APP_PRIVATE_KEY.get());
      const token = await installationToken(await appJwt(c.env.GITHUB_APP_ID, key), installationId);
      return c.json(await rateLimits(token));
    } catch (error) {
      // A suspended installation can't get a token, and GitHub can be down. Either way the page
      // just says it couldn't read the usage.
      console.error(
        JSON.stringify({
          msg: "github rate limit read failed",
          installationId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return c.json({ error: "github_unavailable" }, 502);
    }
  });

// The installation as GitHub shows it to this user, null if their token can't see it, or 'reauth'
// if we have no usable token.
async function verifiedInstallation(c: Context<AppEnv>, installationId: number) {
  const token = await userGitHubToken(c.var.auth, createDb(c.env.DB), c.var.user!.id);
  if (!token) return "reauth" as const;
  const visible = await listOrReauth(token);
  if (visible === "reauth") return visible;
  return visible.find((installation) => installation.id === installationId) ?? null;
}

async function listOrReauth(token: string) {
  try {
    return await listUserInstallations(token);
  } catch (error) {
    // A revoked or expired token. Anything else (GitHub down) should surface as a 500.
    if (error instanceof GitHubError && error.status === 401) return "reauth" as const;
    throw error;
  }
}

export function present(row: typeof schema.githubInstallation.$inferSelect) {
  return {
    id: row.id,
    accountLogin: row.accountLogin,
    accountType: row.accountType,
    repositorySelection: row.repositorySelection,
    suspendedAt: row.suspendedAt,
    settingsUrl: installationSettingsUrl(row),
  };
}
