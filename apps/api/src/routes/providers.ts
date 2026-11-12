import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { createDb } from "../db/index.ts";
import { requireUser } from "../middleware/session.ts";
import { requireWorkspace } from "../middleware/workspace.ts";
import { isCatalogProvider, loadCatalog, withCatalog } from "../provider-catalog.ts";
import { providerReport, providersOverview } from "../provider-report.ts";
import { Days } from "./job-times.ts";

const Query = z.object({ days: Days });

// The Providers page and each provider's page: the workspace's jobs over the last ?days=N days
// (default 14).
export const providerRoutes = new Hono<AppEnv>()
  // Every provider, with the ones operators changed or added in the admin. Signed-in users only;
  // the docs site reads the code list.
  .get("/catalog", requireUser, async (c) =>
    c.json({ providers: await loadCatalog(createDb(c.env.DB)) }),
  )
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
