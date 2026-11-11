import { isProviderId } from "@relayrunner/providers";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { DEFAULT_DAYS, MAX_DAYS } from "../job-times.ts";
import { requireUser } from "../middleware/session.ts";
import { requireWorkspace } from "../middleware/workspace.ts";
import { providerReport } from "../provider-report.ts";

const Query = z.object({
  days: z.coerce.number().int().min(1).max(MAX_DAYS).default(DEFAULT_DAYS),
});

// A provider's page: the workspace's jobs on it over the last ?days=N days (default 14).
export const providerRoutes = new Hono<AppEnv>().get(
  "/:provider",
  requireUser,
  requireWorkspace,
  async (c) => {
    const provider = c.req.param("provider");
    if (!isProviderId(provider)) return c.json({ error: "not_found" }, 404);
    const parsed = Query.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid_query" }, 400);
    return c.json(await providerReport(c.var.db, c.var.workspace.id, provider, parsed.data.days));
  },
);
