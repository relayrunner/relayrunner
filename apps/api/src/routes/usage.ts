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
import {
  BREAKDOWN_BY,
  BREAKDOWN_MAX_ROWS,
  BREAKDOWN_SORTS,
  parseRunFilters,
} from "@relayrunner/api-types";
import { AppError } from "@relayrunner/errors";
import { z } from "zod";
import { breakdown } from "../reports/breakdown.ts";

const BreakdownQuery = z.object({
  by: z.enum(BREAKDOWN_BY),
  sort: z.enum(BREAKDOWN_SORTS).default("minutes"),
  limit: z.coerce.number().int().min(1).max(BREAKDOWN_MAX_ROWS).default(20),
  perDay: z.enum(["0", "1"]).default("0"),
  // Minutes east of UTC, so days end at the reader's midnight.
  utcOffset: z.coerce.number().int().min(-840).max(840).default(0),
});

// The Usage page: how many of the workspace's jobs ran under a minute, and what GitHub's round-up
// to whole minutes cost, over ?from=&to= or the last ?days=N days (default 30), narrowed by the run
// filters (src/reports/run-filters.ts). /checks is what the free checks
// saved over the same range, for the Usage and Activity pages. /actions is each connected GitHub
// account's Actions minutes this billing cycle, read from GitHub billing (#116). /pull-requests is
// CI minutes per pull request. /breakdown is every job's minutes cut one way, for agents
// (src/reports/breakdown.ts).
// As far back as job_timing_daily and activity_event keep.
const USAGE_RANGE = { maxDays: JOB_TIMING_RETENTION_DAYS, defaultDays: 30 };

export const usageRoutes = new Hono<AppEnv>()
  .get("/", requireUser, requireWorkspace, async (c) => {
    const query = c.req.query();
    const window = requireWindow(query, USAGE_RANGE);
    return c.json(await usageReport(c.var.db, c.var.workspace.id, window, parseRunFilters(query)));
  })
  // CI minutes per pull request (src/reports/pull-request-minutes.ts), as far back as job_timing
  // keeps its own rows.
  .get("/pull-requests", requireUser, requireWorkspace, async (c) => {
    const window = requireWindow(c.req.query(), { ...USAGE_RANGE, maxDays: RAW_RETENTION_DAYS });
    return c.json(await pullRequestReport(c.var.db, c.var.workspace.installationId, window));
  })
  .get("/breakdown", requireUser, requireWorkspace, async (c) => {
    const query = c.req.query();
    const parsed = BreakdownQuery.safeParse(query);
    if (!parsed.success) throw new AppError("INVALID_REQUEST");
    const window = requireWindow(query, { ...USAGE_RANGE, maxDays: RAW_RETENTION_DAYS });
    const { perDay, ...options } = parsed.data;
    return c.json(
      await breakdown(c.var.db, c.var.workspace.id, window, {
        ...options,
        perDay: perDay === "1",
        filters: parseRunFilters(query),
      }),
    );
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
