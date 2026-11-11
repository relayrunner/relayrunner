import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../app.ts";
import { createDb, schema } from "../db/index.ts";
import { appInstallationToken, rateLimits } from "../github-app.ts";
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
import { ensureWorkspace, upsertInstallation, userGitHubToken } from "../installations.ts";
import { syncMemberships } from "../memberships.ts";
import { requireUser } from "../middleware/session.ts";
import { requireWorkspace } from "../middleware/workspace.ts";

// GitHub App installations, each of which is a workspace (#316).
//
// 1. "Connect GitHub account" links to GET /install, which sends the user to the App's install
//    page with a signed `state` naming who started it, an optional `?next=<dashboard path>` to land
//    on afterwards (the /device page while `relayrunner connect` onboards a new user), and the
//    origin /install ran on, so /setup can hand the request back there when GitHub's fixed Setup
//    URL is another host. GitHub may also sign the user in during the install ("Request user
//    authorization (OAuth) during installation"). Then it sends them to the App's first callback
//    URL instead, which is /setup too, with `code` and no `state`. So /install also leaves its
//    state in a cookie, and /setup falls back to it.
// 2. GitHub sends them back to the App's Setup URL, GET /setup, with `installation_id`. That id
//    comes from a query string, so it only counts if the user's own GitHub token can see it in
//    GET /user/installations. Then /setup records the installation, makes its workspace (unless
//    the installation webhook got there first), syncs the user's memberships from that same list
//    (src/memberships.ts), and makes the workspace active.
// 3. A brand-new user from `relayrunner connect` has no account yet. /device sends them to
//    GET /signup, which goes straight to the install and leaves the page to come back to in a
//    cookie. /setup then finds them signed out and signs them in with the code GitHub sent
//    (install-sign-in.ts), or, without one, by starting a normal GitHub sign-in, and comes back
//    to /setup to finish step 2 as them.
// 4. Installs made straight on GitHub arrive by webhook, which makes the workspace and records
//    the installer as its owner. Everyone who can see the install joins on their next sign-in or
//    workspace list (src/memberships.ts).

// Where /setup sends the browser, with ?github=<outcome> for the dashboard to explain.
type SetupOutcome = "connected" | "updated" | "requested" | "not_found" | "reauth" | "invalid";

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
  .get("/install", requireUser, async (c) => {
    if (!c.env.GITHUB_APP_SLUG) return c.json({ error: "github_app_slug_not_configured" }, 500);
    const state = await signInstallState(c.env.BETTER_AUTH_SECRET, c.var.user!.id, {
      next: dashboardPath(c.req.query("next")),
      origin: new URL(c.req.url).origin,
    });
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
    // The state only says where to land; who may join the workspace is checked against GitHub.
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
    // `next` in the query is how /setup comes back to itself after signing someone in (below).
    const next = state?.next ?? signupNext ?? dashboardPath(c.req.query("next"));
    const landing = next ?? "/settings/github";
    const done = (outcome: SetupOutcome) => c.redirect(withParam(landing, "github", outcome));
    const requested = c.req.query("setup_action") === "request";
    // A fresh install, rather than coming back after changing one ("update").
    const installed = c.req.query("setup_action") === "install";
    const installationId = Number(c.req.query("installation_id"));
    const validId = Number.isSafeInteger(installationId) && installationId > 0;

    const user = c.var.user;
    // Signed out: a new user signing up through the install, or a session that expired on the
    // way. Sign them in with GitHub, then come back here to add them to the workspace.
    if (!user) {
      const after = landingAfterSignIn({
        next,
        requested,
        installed,
        installationId: validId ? installationId : null,
      });
      // GitHub signed them in during the install and sent a code: use it, so there's no second
      // trip to GitHub. Only for the browser that started the signup (its cookie), so a code in
      // someone else's link can't sign this browser in to their account.
      const code = c.req.query("code");
      if (code && signupNext && (await signInFromInstall(c, code))) return c.redirect(after);
      return signInWithGitHub(c, after);
    }

    // An org member without admin asked an owner to approve the install. Nothing to join yet; the
    // installation webhook makes the workspace once approved.
    if (requested) return done("requested");
    if (!validId) return done("invalid");

    const db = createDb(c.env.DB);
    const visible = await visibleInstallations(c);
    if (visible === "reauth") return done("reauth");
    const verified = visible.find((installation) => installation.id === installationId);
    if (!verified) return done("not_found");
    await upsertInstallation(db, verified);
    const workspaceId = await ensureWorkspace(db, installationId);
    if (!workspaceId) return done("not_found");
    // The list is fresh from GitHub anyway: sync every membership it implies (#317). Signing in
    // on the way here may have synced already, so a fresh install says connected either way.
    const { joined } = await syncMemberships(db, user.id, visible);
    await setActiveWorkspace(c, workspaceId);
    return done(installed || joined.includes(workspaceId) ? "connected" : "updated");
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
          eq(schema.githubInstallation.id, c.var.workspace.installationId),
        ),
      )
      .limit(1);
    if (!row) return c.json({ error: "not_found" }, 404);

    try {
      const token = await appInstallationToken(c.env, installationId);
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

// Where /setup sends someone it had to sign in first: back to /setup, now signed in, to add them
// to the installation's workspace. A request to an org's owners has nothing to join yet.
export function landingAfterSignIn({
  next,
  requested,
  installed = false,
  installationId,
}: {
  next: string | null | undefined;
  requested: boolean;
  installed?: boolean;
  installationId: number | null;
}) {
  if (requested) return withParam(next ?? "/settings/github", "github", "requested");
  if (!installationId) return next ?? "/settings/github?github=invalid";
  const setup = new URLSearchParams({ installation_id: String(installationId) });
  if (installed) setup.set("setup_action", "install");
  if (next) setup.set("next", next);
  return `/api/github/setup?${setup}`;
}

// Makes `workspaceId` the session's active workspace, so the dashboard opens on the one just
// installed. Better Auth refreshes its cached session cookie in the response; pass it on.
async function setActiveWorkspace(c: Context<AppEnv>, workspaceId: string) {
  const response = await c.var.auth.api
    .setActiveOrganization({
      body: { organizationId: workspaceId },
      headers: c.req.raw.headers,
      asResponse: true,
    })
    .catch(() => null);
  if (!response?.ok) return;
  for (const cookie of response.headers.getSetCookie())
    c.header("set-cookie", cookie, { append: true });
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

// The installations GitHub shows this user, or 'reauth' if we have no usable token.
async function visibleInstallations(c: Context<AppEnv>) {
  const token = await userGitHubToken(c.var.auth, createDb(c.env.DB), c.var.user!.id);
  if (!token) return "reauth" as const;
  return listOrReauth(token);
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
