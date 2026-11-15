import { Hono } from "hono";
import { refreshWorkspaceUsage, workspaceActionsUsage } from "../actions-billing.ts";
import type { AppEnv } from "../app.ts";
import { freeCheckSavings } from "../free-checks.ts";
import { usageReport } from "../job-timings.ts";
import { requireUser } from "../middleware/session.ts";
import { requireWorkspace } from "../middleware/workspace.ts";
import { parseDays } from "./days.ts";
import { AppError } from "@relayrunner/errors";

// The Usage page: how many of the workspace's jobs ran under a minute, and what GitHub's round-up
// to whole minutes cost, over the last ?days=N days (default 30). /checks is what the free checks
// saved over the same range, for the Usage and Activity pages. /actions is each connected GitHub
// account's Actions minutes this billing cycle, read from GitHub billing (#116).
export const usageRoutes = new Hono<AppEnv>()
  .get("/", requireUser, requireWorkspace, async (c) => {
    const days = parseDays(c.req.query());
    if (days === null) throw new AppError("INVALID_REQUEST");
    return c.json(await usageReport(c.var.db, c.var.workspace.id, days));
  })
  .get("/checks", requireUser, requireWorkspace, async (c) => {
    const days = parseDays(c.req.query());
    if (days === null) throw new AppError("INVALID_REQUEST");
    return c.json(await freeCheckSavings(c.var.db, c.var.workspace.id, days));
  })
  .get("/actions", requireUser, requireWorkspace, async (c) => {
    return c.json(await workspaceActionsUsage(c.var.db, c.var.workspace.id));
  })
  // Reads GitHub billing again now (at most once a minute per account), then answers as GET does.
  .post("/actions/refresh", requireUser, requireWorkspace, async (c) => {
    await refreshWorkspaceUsage(c.env, c.var.workspace.id);
    return c.json(await workspaceActionsUsage(c.var.db, c.var.workspace.id));
  });
