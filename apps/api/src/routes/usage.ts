import { Hono } from "hono";
import { refreshWorkspaceUsage, workspaceActionsUsage } from "../providers/actions-billing.ts";
import type { AppEnv } from "../app.ts";
import { freeCheckSavings } from "../checks/free-checks.ts";
import { usageReport } from "../ingest/job-timings.ts";
import { JOB_TIMING_RETENTION_DAYS, RAW_RETENTION_DAYS } from "../time.ts";
import { requireUser } from "../middleware/session.ts";
import { requireWorkspace } from "../middleware/workspace.ts";
import { pullRequestReport } from "../reports/pull-request-minutes.ts";
import { requireWindow } from "../reports/report-window.ts";

// The Usage page: how many of the workspace's jobs ran under a minute, and what GitHub's round-up
// to whole minutes cost, over ?from=&to= or the last ?days=N days (default 30). /checks is what the free checks
// saved over the same range, for the Usage and Activity pages. /actions is each connected GitHub
// account's Actions minutes this billing cycle, read from GitHub billing (#116). /pull-requests is
// CI minutes per pull request.
// As far back as job_timing_daily and activity_event keep.
const USAGE_RANGE = { maxDays: JOB_TIMING_RETENTION_DAYS, defaultDays: 30 };

export const usageRoutes = new Hono<AppEnv>()
  .get("/", requireUser, requireWorkspace, async (c) => {
    const window = requireWindow(c.req.query(), USAGE_RANGE);
    return c.json(await usageReport(c.var.db, c.var.workspace.id, window));
  })
  // CI minutes per pull request (src/reports/pull-request-minutes.ts), as far back as job_timing
  // keeps its own rows.
  .get("/pull-requests", requireUser, requireWorkspace, async (c) => {
    const window = requireWindow(c.req.query(), { ...USAGE_RANGE, maxDays: RAW_RETENTION_DAYS });
    return c.json(await pullRequestReport(c.var.db, c.var.workspace.installationId, window));
  })
  .get("/checks", requireUser, requireWorkspace, async (c) => {
    const window = requireWindow(c.req.query(), USAGE_RANGE);
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
