import { isBillingProvider } from "@relayrunner/providers";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { blacksmithMinutes } from "../providers/blacksmith-minutes.ts";
import { createDb } from "../db/index.ts";
import { groundboxMinutesView, readGroundboxAccount } from "../providers/groundbox-account.ts";
import { requireUser } from "../middleware/session.ts";
import { requireWorkspace } from "../middleware/workspace.ts";
import { isCatalogProvider, loadCatalog } from "../providers/provider-catalog.ts";
import {
  connectProvider,
  disconnectProvider,
  listConnections,
  parseOptions,
  testConnection,
} from "../providers/provider-connections.ts";
import { providerReport, providersOverview } from "../reports/provider-report.ts";
import { workspaceSpend } from "../providers/provider-spend.ts";
import { providerTrends } from "../reports/provider-trends.ts";
import { chartBuckets, requireWindow } from "../reports/report-window.ts";
import { RAW_RETENTION_DAYS } from "../time.ts";
import { DEFAULT_DAYS } from "../reports/job-times.ts";
import { requireManager } from "../auth/roles.ts";
import { dashboardPath } from "../github/github.ts";
import { log } from "../log.ts";
import { authorizeUrl, boatOAuthConfigured, exchangeCode, pkce } from "../providers/boat-oauth.ts";
import { boatReadiness, saveBoatGrant } from "../providers/boat-connect.ts";
import { AppError } from "@relayrunner/errors";

const ConnectBody = z.object({
  token: z.string().trim().min(8).max(4096),
  options: z.record(z.string(), z.string()).optional(),
});

// The Providers page and each provider's page: the workspace's jobs over ?from=&to= or the last
// ?days=N days (default 14), as far back as job_timing keeps each job.
const RANGE = { maxDays: RAW_RETENTION_DAYS, defaultDays: DEFAULT_DAYS };

// "Connect Boat" (src/providers/boat-oauth.ts): the PKCE verifier and state ride in a cookie scoped
// to these routes for the trip to Boat and back, so neither shows up in a URL.
const BOAT_OAUTH_COOKIE = "rr_boat_oauth";
const BOAT_OAUTH_PATH = "/api/providers/boat";
const BOAT_LANDING = "/providers/boat/evaluate";
const BoatOAuthCookie = z.object({
  state: z.string(),
  verifier: z.string(),
  workspaceId: z.string(),
  next: z.string(),
});

/** `next` with ?boat=<outcome> added, for the page to say what happened. */
function landing(next: string, outcome: "connected" | "cancelled" | "failed") {
  const url = new URL(next, "https://dashboard.invalid");
  url.searchParams.set("boat", outcome);
  return `${url.pathname}${url.search}`;
}

export const providerRoutes = new Hono<AppEnv>()
  // Every provider, with the ones operators changed or added in the admin. Signed-in users only;
  // the docs site reads the code list.
  .get("/catalog", requireUser, async (c) =>
    c.json({ providers: await loadCatalog(createDb(c.env.DB)) }),
  )
  // Settings → Providers: each provider a workspace can connect, and what it has synced. Any member
  // can look; only owners and admins change them. Tokens never come back.
  .get("/connections", requireUser, requireWorkspace, async (c) =>
    c.json({ connections: await listConnections(c.var.db, c.var.workspace.id) }),
  )
  // The Router's Blacksmith step: the workspace's free Blacksmith minutes this month, counted from
  // its Blacksmith connection, or why they can't be.
  .get("/blacksmith/minutes", requireUser, requireWorkspace, async (c) =>
    c.json(await blacksmithMinutes(c.var.db, c.var.workspace.id)),
  )
  // The Router's Groundbox step: its free minutes this month and whether it's holding jobs, read
  // live from the workspace's Groundbox connection, or why they can't be.
  .get("/groundbox/minutes", requireUser, requireWorkspace, async (c) =>
    c.json(groundboxMinutesView(await readGroundboxAccount(c.env, c.var.db, c.var.workspace.id))),
  )
  // The Router's spend bars: what the workspace's GitHub account has spent on each priced
  // provider this month, at list prices, in dollars. GitHub-hosted's comes from its own billing
  // (GET /api/usage/actions netAmount), not from here.
  .get("/spend", requireUser, requireWorkspace, async (c) =>
    c.json({
      spend: await workspaceSpend(c.var.db, c.var.workspace.installationId),
    }),
  )
  // Evaluate's Boat Connect step: whether Boat can run the workspace's jobs yet, read live.
  .get("/boat/readiness", requireUser, requireWorkspace, async (c) =>
    c.json(await boatReadiness(c.env, c.var.db, c.var.workspace.id)),
  )
  // Send the browser to Boat's sign-in, to come back to /boat/callback and then ?next=.
  .get("/boat/connect", requireUser, requireWorkspace, requireManager, async (c) => {
    if (!boatOAuthConfigured(c.env)) throw new AppError("PROVIDER_SIGN_IN_UNAVAILABLE");
    // Boat comes back to the one registered host, so the cookie has to be set there.
    const production = new URL(c.env.BETTER_AUTH_URL).origin;
    const here = new URL(c.req.url);
    if (here.origin !== production)
      return c.redirect(`${production}${here.pathname}${here.search}`);
    const { verifier, challenge, state } = await pkce();
    const cookie = {
      state,
      verifier,
      workspaceId: c.var.workspace.id,
      next: dashboardPath(c.req.query("next")) ?? BOAT_LANDING,
    } satisfies z.infer<typeof BoatOAuthCookie>;
    setCookie(c, BOAT_OAUTH_COOKIE, JSON.stringify(cookie), {
      path: BOAT_OAUTH_PATH,
      httpOnly: true,
      secure: here.protocol === "https:",
      // Boat's redirect back is a top-level GET, which Lax cookies ride along on.
      sameSite: "Lax",
      maxAge: 15 * 60,
    });
    return c.redirect(authorizeUrl(c.env, { challenge, state }));
  })
  .get("/boat/callback", requireUser, requireWorkspace, requireManager, async (c) => {
    const raw = getCookie(c, BOAT_OAUTH_COOKIE);
    deleteCookie(c, BOAT_OAUTH_COOKIE, { path: BOAT_OAUTH_PATH });
    const saved = BoatOAuthCookie.safeParse(
      (() => {
        try {
          return JSON.parse(raw ?? "");
        } catch {
          return null;
        }
      })(),
    );
    if (!saved.success) return c.redirect(landing(BOAT_LANDING, "failed"));
    const { state, verifier, workspaceId, next } = saved.data;
    if (c.req.query("error") === "access_denied") return c.redirect(landing(next, "cancelled"));
    const code = c.req.query("code");
    // The state proves this browser started the trip; the workspace must still be the one it was
    // for, so a switch meanwhile can't connect Boat to another.
    if (!code || c.req.query("state") !== state || workspaceId !== c.var.workspace.id)
      return c.redirect(landing(next, "failed"));
    try {
      const grant = await exchangeCode(c.env, { code, verifier });
      await saveBoatGrant(c.env, c.var.db, { workspaceId, userId: c.var.user!.id, grant });
    } catch (error) {
      log.warn("provider.boat_connect_failed", "boat oauth connect failed", { workspaceId, error });
      return c.redirect(landing(next, "failed"));
    }
    return c.redirect(landing(next, "connected"));
  })
  .use("/:provider/connection/*", requireUser, requireWorkspace, requireManager)
  // Save (or replace) a token, after one read proves it works. Then sync right away.
  .put("/:provider/connection", async (c) => {
    const provider = c.req.param("provider");
    if (!isBillingProvider(provider)) throw new AppError("NOT_FOUND");
    const parsed = ConnectBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      throw new AppError("INVALID_REQUEST", { message: "Paste the whole token." });
    const options = parseOptions(provider, parsed.data.options);
    if (!options)
      throw new AppError("INVALID_REQUEST", { message: "Choose one of the listed options." });
    const result = await connectProvider(c.env, c.var.db, {
      workspaceId: c.var.workspace.id,
      provider,
      token: parsed.data.token,
      options,
      userId: c.var.user!.id,
    });
    // The provider's own words go in details; the message says what to do.
    if (!result.ok) throw new AppError(result.error, { details: { reason: result.message } });
    return c.json(result.connection);
  })
  // Check the saved token still works.
  .post("/:provider/connection/test", async (c) => {
    const provider = c.req.param("provider");
    if (!isBillingProvider(provider)) throw new AppError("NOT_FOUND");
    const result = await testConnection(c.env, c.var.db, c.var.workspace.id, provider);
    if (!result) throw new AppError("PROVIDER_NOT_CONNECTED");
    return c.json(result);
  })
  // Forget the token and everything synced with it.
  .delete("/:provider/connection", async (c) => {
    const provider = c.req.param("provider");
    if (!isBillingProvider(provider)) throw new AppError("NOT_FOUND");
    return c.json(await disconnectProvider(c.var.db, c.var.workspace.id, provider));
  })
  .get("/", requireUser, requireWorkspace, async (c) => {
    const query = c.req.query();
    const window = requireWindow(query, RANGE);
    // The Providers page's minutes chart sends ?origin= (and ?per=hour or ?per=week for hourly or weekly bars); the
    // Runners page only reads the totals.
    const buckets =
      query.origin === undefined ? null : chartBuckets(window, query.origin, query.per);
    return c.json(await providersOverview(c.var.db, c.var.workspace.id, window, buckets));
  })
  // A provider page's charts (src/reports/provider-trends.ts), a bar a day from ?origin= (the reader's
  // midnight), or a week past a month.
  .get("/:provider/trends", requireUser, requireWorkspace, async (c) => {
    const provider = c.req.param("provider");
    if (!isCatalogProvider(provider)) throw new AppError("NOT_FOUND");
    const query = c.req.query();
    const window = requireWindow(query, RANGE);
    const buckets = chartBuckets(window, query.origin);
    return c.json(await providerTrends(c.var.db, c.var.workspace.id, provider, window, buckets));
  })
  .get("/:provider", requireUser, requireWorkspace, async (c) => {
    const provider = c.req.param("provider");
    if (!isCatalogProvider(provider)) throw new AppError("NOT_FOUND");
    const window = requireWindow(c.req.query(), RANGE);
    return c.json(await providerReport(c.var.db, c.var.workspace.id, provider, window));
  });
