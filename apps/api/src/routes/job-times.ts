import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { DEFAULT_DAYS, jobRuns, MAX_DAYS, machineJobTimes } from "../job-times.ts";
import { requireUser } from "../middleware/session.ts";
import { requireWorkspace } from "../middleware/workspace.ts";
import { withCatalog } from "../provider-catalog.ts";
import { jobTypeTimes } from "../job-type-times.ts";
import { performanceReport } from "../runs.ts";
import { workflowReport } from "../workflow-compare.ts";
import { MAX_RANGE_MS, runnerReport } from "../runner-report.ts";
import { Epoch, requireWindow } from "../report-window.ts";
import { RAW_RETENTION_DAYS } from "../time.ts";
import { AppError } from "@relayrunner/errors";

/** A report's `?days=N`. */
const Days = z.coerce.number().int().min(1).max(MAX_DAYS).default(DEFAULT_DAYS);

/** A report's window (`?from=&to=` or `?days=N`), as far back as single jobs go. */
const JOB_WINDOW = { maxDays: RAW_RETENTION_DAYS, defaultDays: DEFAULT_DAYS };
export const jobWindow = (query: Record<string, string>) => requireWindow(query, JOB_WINDOW);

/** Minutes east of UTC, so days end at the reader's midnight. */
const UtcOffset = z.coerce.number().int().min(-840).max(840).default(0);

const DaysQuery = z.object({ days: Days });

const RunsQuery = z.object({
  repositoryId: z.coerce.number().int().positive(),
  // Left out for a job whose workflow has no name.
  workflow: z.string().min(1).optional(),
  name: z.string().min(1),
  // `name` is a matrix job's shared name: take in every leg.
  matrix: z.enum(["true", "false"]).default("false"),
});

const WorkflowQuery = z.object({
  repositoryId: z.coerce.number().int().positive(),
  // Left out for a workflow with no name.
  workflow: z.string().min(1).optional(),
});

const TypesQuery = z.object({ utcOffset: UtcOffset });

const RunnerQuery = z
  .object({
    // The window in epoch ms; `to` defaults to now.
    from: Epoch,
    to: Epoch.optional(),
    // A Performance environment key, such as `github:linux-2-core` or `machine:<id>`.
    key: z.string().min(1).max(500),
    utcOffset: UtcOffset,
  })
  .refine(({ from, to = Date.now() }) => from < to && to - from <= MAX_RANGE_MS);

// The Performance page: how long each workflow and job usually takes on each runner environment in
// a window: ?from=&to= (with ?priorFrom= for the trend), or the last ?days=N (default 14). /runs is one job's runs, for its detail chart. /workflow is one workflow on every runner it ran on. /machines is
// each machine's typical job, for the Runners page. /runner is one runner's detail panel. /types
// is each job's run time by day with its type, for the Job types tab.
export const jobTimesRoutes = new Hono<AppEnv>()
  .get("/", requireUser, requireWorkspace, withCatalog, async (c) => {
    const window = jobWindow(c.req.query());
    return c.json(await performanceReport(c.var.db, c.var.workspace.id, window));
  })
  .get("/runs", requireUser, requireWorkspace, withCatalog, async (c) => {
    const parsed = RunsQuery.safeParse(c.req.query());
    if (!parsed.success) throw new AppError("INVALID_REQUEST");
    const window = jobWindow(c.req.query());
    const { repositoryId, workflow, name, matrix } = parsed.data;
    const job = { repositoryId, workflow: workflow ?? null, name, matrix: matrix === "true" };
    return c.json(await jobRuns(c.var.db, c.var.workspace.id, job, window));
  })
  .get("/workflow", requireUser, requireWorkspace, withCatalog, async (c) => {
    const parsed = WorkflowQuery.safeParse(c.req.query());
    if (!parsed.success) throw new AppError("INVALID_REQUEST");
    const window = jobWindow(c.req.query());
    const { repositoryId, workflow = null } = parsed.data;
    const report = await workflowReport(
      c.var.db,
      c.var.workspace.id,
      { repositoryId, workflow },
      window,
    );
    if (!report) throw new AppError("NOT_FOUND");
    return c.json(report);
  })
  .get("/types", requireUser, requireWorkspace, async (c) => {
    const parsed = TypesQuery.safeParse(c.req.query());
    if (!parsed.success) throw new AppError("INVALID_REQUEST");
    const window = jobWindow(c.req.query());
    const { utcOffset } = parsed.data;
    return c.json(await jobTypeTimes(c.var.db, c.var.workspace.id, window, { utcOffset }));
  })
  .get("/machines", requireUser, requireWorkspace, withCatalog, async (c) => {
    const parsed = DaysQuery.safeParse(c.req.query());
    if (!parsed.success) throw new AppError("INVALID_REQUEST");
    return c.json(await machineJobTimes(c.var.db, c.var.workspace.id, parsed.data.days));
  })
  .get("/runner", requireUser, requireWorkspace, withCatalog, async (c) => {
    const parsed = RunnerQuery.safeParse(c.req.query());
    if (!parsed.success) throw new AppError("INVALID_REQUEST");
    const { key, ...options } = parsed.data;
    return c.json(await runnerReport(c.var.db, c.var.workspace.id, key, options));
  });
