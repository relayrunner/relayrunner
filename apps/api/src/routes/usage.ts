import { Hono } from "hono";
import { refreshWorkspaceUsage, workspaceActionsUsage } from "../actions-billing.ts";
import type { AppEnv } from "../app.ts";
import { freeCheckSavings } from "../free-checks.ts";
import { usageReport } from "../job-timings.ts";
import { JOB_TIMING_RETENTION_DAYS } from "../time.ts";
import { requireUser } from "../middleware/session.ts";
import { requireWorkspace } from "../middleware/workspace.ts";
import { parseWindow } from "../report-window.ts";
import { AppError } from "@relayrunner/errors";

// The Usage page: how many of the workspace's jobs ran under a minute, and what GitHub's round-up
// to whole minutes cost, over ?from=&to= or the last ?days=N days (default 30). /checks is what the free checks
// saved over the same range, for the Usage and Activity pages. /actions is each connected GitHub
// account's Actions minutes this billing cycle, read from GitHub billing (#116).
// As far back as job_timing_daily and activity_event keep.
const USAGE_RANGE = { maxDays: JOB_TIMING_RETENTION_DAYS, defaultDays: 30 };

export const usageRoutes = new Hono<AppEnv>()
  .get("/", requireUser, requireWorkspace, async (c) => {
    const window = parseWindow(c.req.query(), USAGE_RANGE);
    if (!window) throw new AppError("INVALID_REQUEST");
    return c.json(await usageReport(c.var.db, c.var.workspace.id, window));
  })
  .get("/checks", requireUser, requireWorkspace, async (c) => {
    const window = parseWindow(c.req.query(), USAGE_RANGE);
    if (!window) throw new AppError("INVALID_REQUEST");
    return c.json(await freeCheckSavings(c.var.db, c.var.workspace.id, window));
  })
  .get("/actions", requireUser, requireWorkspace, async (c) => {
    return c.json(await workspaceActionsUsage(c.var.db, c.var.workspace.id));
  })
  // Reads GitHub billing again now (at most once a minute per account), then answers as GET does.
  .post("/actions/refresh", requireUser, requireWorkspace, async (c) => {
    await refreshWorkspaceUsage(c.env, c.var.workspace.id);
    return c.json(await workspaceActionsUsage(c.var.db, c.var.workspace.id));
  });
