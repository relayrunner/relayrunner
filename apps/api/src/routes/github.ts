import { and, eq, inArray, isNull } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../app.ts";
import { createDb, schema } from "../db/index.ts";
import { appJwt, importAppPrivateKey, installationToken, rateLimits } from "../github-app.ts";
import {
  dashboardPath,
  GitHubError,
  appInstallUrl,
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
//    GitHub may also sign the user in during the install ("Request user authorization (OAuth)
//    during installation"). Then it sends them to the App's first callback URL instead, which is
//    /setup too, with `code` and no `state`. So /install also leaves its state in a cookie, and
//    /setup falls back to it.
// 3. A brand-new user from `relayrunner connect` has no account or workspace yet. /device sends
//    them to GET /signup, which goes straight to the install and leaves the page to come back to
//    in a cookie. /setup then finds them signed out and signs them in with the code GitHub sent
//    (install-sign-in.ts), or, without one, by starting a normal GitHub sign-in. Either way it
//    lands on that page with ?installed=<id>. /device makes their workspace and claims that installation into it.
// 4. Installs made straight on GitHub arrive with no `state` (or by webhook only) and stay
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

// Cookies that carry the install across GitHub when GitHub's redirect drops our `state`. Scoped
// to these routes, and only good for as long as the install might take.
const INSTALL_STATE_COOKIE = "rr_install_state";
const SIGNUP_NEXT_COOKIE = "rr_signup_next";
const cookieOptions = (c: Context<AppEnv>) => ({
  path: "/api/github",
  httpOnly: true,
  secure: new URL(c.req.url).protocol === "https:",
  // GitHub's redirect back is a top-level GET, which Lax cookies ride along on.
  sameSite: "Lax" as const,
  maxAge: 30 * 60,
});

export const githubRoutes = new Hono<AppEnv>()
  .get("/install", requireUser, requireWorkspace, requireManager, async (c) => {
    if (!c.env.GITHUB_APP_SLUG) return c.json({ error: "github_app_slug_not_configured" }, 500);
    const state = await signInstallState(
      c.env.BETTER_AUTH_SECRET,
      c.var.workspace.id,
      c.var.user!.id,
      { next: dashboardPath(c.req.query("next")), origin: new URL(c.req.url).origin },
    );
    setCookie(c, INSTALL_STATE_COOKIE, state, cookieOptions(c));
    return c.redirect(installUrl(c.env.GITHUB_APP_SLUG, state));
  })

  // Sign up and install in one trip, for someone with no account yet (see 3. above).
  .get("/signup", async (c) => {
    if (!c.env.GITHUB_APP_SLUG) return c.json({ error: "github_app_slug_not_configured" }, 500);
    // GitHub comes back to the production host, so the cookie has to be set there.
    const production = new URL(c.env.BETTER_AUTH_URL).origin;
    const here = new URL(c.req.url);
    if (here.origin !== production)
      return c.redirect(`${production}${here.pathname}${here.search}`);
    const next = dashboardPath(c.req.query("next"));
    if (next) setCookie(c, SIGNUP_NEXT_COOKIE, next, cookieOptions(c));
    else deleteCookie(c, SIGNUP_NEXT_COOKIE, { path: "/api/github" });
    return c.redirect(appInstallUrl(c.env.GITHUB_APP_SLUG));
  })

  .get("/setup", async (c) => {
    // The state is read up front only for where to land afterwards; whether it may link anything
    // is checked against the signed-in user below.
    const stateParam = c.req.query("state") ?? getCookie(c, INSTALL_STATE_COOKIE);
    const signupNext = dashboardPath(getCookie(c, SIGNUP_NEXT_COOKIE));
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
    // Used up either way.
    deleteCookie(c, INSTALL_STATE_COOKIE, { path: "/api/github" });
    deleteCookie(c, SIGNUP_NEXT_COOKIE, { path: "/api/github" });
    const landing = state?.next ?? signupNext ?? "/settings/github";
    const done = (outcome: SetupOutcome) => c.redirect(withParam(landing, "github", outcome));
    const requested = c.req.query("setup_action") === "request";
    const installationId = Number(c.req.query("installation_id"));
    const validId = Number.isSafeInteger(installationId) && installationId > 0;

    const user = c.var.user;
    // Signed out: a new user signing up through the install, or a session that expired on the
    // way. Sign them in with GitHub and come back to the page, which claims the installation (the
    // webhook records it either way).
    if (!user) {
      const after = landingAfterSignIn({
        next: state?.next ?? signupNext,
        requested,
        installationId: validId ? installationId : null,
      });
      // GitHub signed them in during the install and sent a code: use it, so there's no second
      // trip to GitHub. Only for the browser that started the signup (its cookie), so a code in
      // someone else's link can't sign this browser in to their account.
      const code = c.req.query("code");
      if (code && signupNext && (await signInFromInstall(c, code))) return c.redirect(after);
      return signInWithGitHub(c, after);
    }

    // An org member without admin asked an owner to approve the install. Nothing to link yet; the
    // installation webhook records it once approved.
    if (requested) return done("requested");
    if (!validId) return done("invalid");

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

    // Signed up through the install while somehow already signed in: the page claims it.
    if (signupNext) return c.redirect(withParam(signupNext, "installed", String(installationId)));
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

function withParam(path: string, key: string, value: string) {
  const url = new URL(path, "https://dashboard.invalid");
  url.searchParams.set(key, value);
  return `${url.pathname}${url.search}`;
}

// Where /setup sends someone it had to sign in first. Without a page to go back to, the
// installation waits to be claimed in settings.
export function landingAfterSignIn({
  next,
  requested,
  installationId,
}: {
  next: string | null | undefined;
  requested: boolean;
  installationId: number | null;
}) {
  if (!next) return "/settings/github?github=unclaimed";
  if (requested) return withParam(next, "github", "requested");
  return installationId ? withParam(next, "installed", String(installationId)) : next;
}

// Creates the session from the code GitHub sent after the install (install-sign-in.ts). False
// if GitHub won't take the code, and the caller falls back to a normal sign-in.
async function signInFromInstall(c: Context<AppEnv>, code: string) {
  const response = await c.var.auth.api
    .signInFromInstall({ body: { code }, headers: c.req.raw.headers, asResponse: true })
    .catch(() => null);
  if (!response?.ok) return false;
  for (const cookie of response.headers.getSetCookie())
    c.header("set-cookie", cookie, { append: true });
  return true;
}

// Starts Better Auth's GitHub sign-in, as the dashboard's sign-in button would, and lands on
// `callbackURL` (a dashboard path) once signed in.
async function signInWithGitHub(c: Context<AppEnv>, callbackURL: string) {
  const response = await c.var.auth.api.signInSocial({
    body: { provider: "github", callbackURL, disableRedirect: true },
    headers: c.req.raw.headers,
    asResponse: true,
  });
  const { url } = (await response.json()) as { url?: string };
  if (!url) return c.redirect(`/login?redirect=${encodeURIComponent(callbackURL)}`);
  // Better Auth's state cookie, which its callback checks.
  for (const cookie of response.headers.getSetCookie())
    c.header("set-cookie", cookie, { append: true });
  return c.redirect(url);
}

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
