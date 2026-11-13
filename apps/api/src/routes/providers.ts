import { isBillingProvider } from "@relayrunner/providers";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { createDb } from "../db/index.ts";
import { requireUser } from "../middleware/session.ts";
import { requireWorkspace } from "../middleware/workspace.ts";
import { isCatalogProvider, loadCatalog, withCatalog } from "../provider-catalog.ts";
import {
  connectProvider,
  disconnectProvider,
  listConnections,
  parseOptions,
  testConnection,
} from "../provider-connections.ts";
import { providerReport, providersOverview } from "../provider-report.ts";
import { TokenKeyError } from "../provider-tokens.ts";
import { requireManager } from "../roles.ts";
import { Days } from "./job-times.ts";

const Query = z.object({ days: Days });

const ConnectBody = z.object({
  token: z.string().trim().min(8).max(4096),
  options: z.record(z.string(), z.string()).optional(),
});

// Saving or reading a token needs PROVIDER_TOKEN_KEY; without it, say so instead of a bare 500.
const tokenStorage = createMiddleware<AppEnv>(async (c, next) => {
  await next();
  if (c.error instanceof TokenKeyError) c.res = c.json({ error: "token_storage_unavailable" }, 503);
});

// The Providers page and each provider's page: the workspace's jobs over the last ?days=N days
// (default 14).
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
  .use("/:provider/connection/*", requireUser, requireWorkspace, requireManager, tokenStorage)
  // Save (or replace) a token, after one read proves it works. Then sync right away.
  .put("/:provider/connection", async (c) => {
    const provider = c.req.param("provider");
    if (!isBillingProvider(provider)) return c.json({ error: "not_found" }, 404);
    const parsed = ConnectBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_token" }, 400);
    const options = parseOptions(provider, parsed.data.options);
    if (!options) return c.json({ error: "invalid_options" }, 400);
    const result = await connectProvider(c.env, c.var.db, {
      workspaceId: c.var.workspace.id,
      provider,
      token: parsed.data.token,
      options,
      userId: c.var.user!.id,
    });
    if (!result.ok)
      return c.json(
        { error: result.error, message: result.message },
        result.error === "token_rejected" ? 400 : 502,
      );
    return c.json(result.connection);
  })
  // Check the saved token still works.
  .post("/:provider/connection/test", async (c) => {
    const provider = c.req.param("provider");
    if (!isBillingProvider(provider)) return c.json({ error: "not_found" }, 404);
    const result = await testConnection(c.env, c.var.db, c.var.workspace.id, provider);
    if (!result) return c.json({ error: "not_connected" }, 404);
    return c.json(result);
  })
  // Forget the token and everything synced with it.
  .delete("/:provider/connection", async (c) => {
    const provider = c.req.param("provider");
    if (!isBillingProvider(provider)) return c.json({ error: "not_found" }, 404);
    return c.json(await disconnectProvider(c.var.db, c.var.workspace.id, provider));
  })
  .get("/", requireUser, requireWorkspace, withCatalog, async (c) => {
    const parsed = Query.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid_query" }, 400);
    return c.json(await providersOverview(c.var.db, c.var.workspace.id, parsed.data.days));
  })
  .get("/:provider", requireUser, requireWorkspace, withCatalog, async (c) => {
    const provider = c.req.param("provider");
    if (!isCatalogProvider(provider)) return c.json({ error: "not_found" }, 404);
    const parsed = Query.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid_query" }, 400);
    return c.json(await providerReport(c.var.db, c.var.workspace.id, provider, parsed.data.days));
  });
