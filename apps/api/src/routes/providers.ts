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
import { AppError } from "@relayrunner/errors";
import { respondError } from "../errors.ts";

const Query = z.object({ days: Days });

const ConnectBody = z.object({
  token: z.string().trim().min(8).max(4096),
  options: z.record(z.string(), z.string()).optional(),
});

// Saving or reading a token needs PROVIDER_TOKEN_KEY; without it, say so instead of a bare 500.
const tokenStorage = createMiddleware<AppEnv>(async (c, next) => {
  await next();
  if (c.error instanceof TokenKeyError)
    c.res = respondError(c, new AppError("TOKEN_STORAGE_UNAVAILABLE"));
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
    if (!result.ok) {
      const code =
        result.error === "token_rejected" ? "PROVIDER_TOKEN_REJECTED" : "PROVIDER_UNREACHABLE";
      throw new AppError(code, { message: result.message });
    }
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
  .get("/", requireUser, requireWorkspace, withCatalog, async (c) => {
    const parsed = Query.safeParse(c.req.query());
    if (!parsed.success) throw new AppError("INVALID_REQUEST");
    return c.json(await providersOverview(c.var.db, c.var.workspace.id, parsed.data.days));
  })
  .get("/:provider", requireUser, requireWorkspace, withCatalog, async (c) => {
    const provider = c.req.param("provider");
    if (!isCatalogProvider(provider)) throw new AppError("NOT_FOUND");
    const parsed = Query.safeParse(c.req.query());
    if (!parsed.success) throw new AppError("INVALID_REQUEST");
    return c.json(await providerReport(c.var.db, c.var.workspace.id, provider, parsed.data.days));
  });
