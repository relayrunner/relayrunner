import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { DEFAULT_DAYS, jobRuns, MAX_DAYS, machineJobTimes } from "../job-times.ts";
import { requireUser } from "../middleware/session.ts";
import { requireWorkspace } from "../middleware/workspace.ts";
import { withCatalog } from "../provider-catalog.ts";
import { jobTypeTimes } from "../job-type-times.ts";
import { performanceReport } from "../runs.ts";
import { MAX_RANGE_MS, runnerReport } from "../runner-report.ts";
import { AppError } from "@relayrunner/errors";

/** A report's `?days=N`, shared by the routes that take one. */
export const Days = z.coerce.number().int().min(1).max(MAX_DAYS).default(DEFAULT_DAYS);

const DaysQuery = z.object({ days: Days });

const RunsQuery = z.object({
  days: Days,
  repositoryId: z.coerce.number().int().positive(),
  // Left out for a job whose workflow has no name.
  workflow: z.string().min(1).optional(),
  name: z.string().min(1),
  // `name` is a matrix job's shared name: take in every leg.
  matrix: z.enum(["true", "false"]).default("false"),
});

const TypesQuery = z.object({
  days: Days,
  // Minutes east of UTC, so days end at the reader's midnight.
  utcOffset: z.coerce.number().int().min(-840).max(840).default(0),
});

const Epoch = z.coerce.number().int().min(0);

const RunnerQuery = z
  .object({
    // The window in epoch ms; `to` defaults to now.
    from: Epoch,
    to: Epoch.optional(),
    // A Performance environment key, such as `github:linux-2-core` or `machine:<id>`.
    key: z.string().min(1).max(500),
    // Minutes east of UTC, so days end at the reader's midnight.
    utcOffset: z.coerce.number().int().min(-840).max(840).default(0),
  })
  .refine(({ from, to = Date.now() }) => from < to && to - from <= MAX_RANGE_MS);

// The Performance page: how long each workflow and job usually takes on each runner environment over
// the last ?days=N days (default 14). /runs is one job's runs, for its detail chart. /machines is
// each machine's typical job, for the Runners page. /runner is one runner's detail panel. /types
// is each job's run time by day with its type, for the Job types tab.
export const jobTimesRoutes = new Hono<AppEnv>()
  .get("/", requireUser, requireWorkspace, withCatalog, async (c) => {
    const parsed = DaysQuery.safeParse(c.req.query());
    if (!parsed.success) throw new AppError("INVALID_REQUEST");
    return c.json(await performanceReport(c.var.db, c.var.workspace.id, parsed.data.days));
  })
  .get("/runs", requireUser, requireWorkspace, withCatalog, async (c) => {
    const parsed = RunsQuery.safeParse(c.req.query());
    if (!parsed.success) throw new AppError("INVALID_REQUEST");
    const { days, repositoryId, workflow, name, matrix } = parsed.data;
    const job = { repositoryId, workflow: workflow ?? null, name, matrix: matrix === "true" };
    return c.json(await jobRuns(c.var.db, c.var.workspace.id, job, days));
  })
  .get("/types", requireUser, requireWorkspace, async (c) => {
    const parsed = TypesQuery.safeParse(c.req.query());
    if (!parsed.success) throw new AppError("INVALID_REQUEST");
    const { days, utcOffset } = parsed.data;
    return c.json(await jobTypeTimes(c.var.db, c.var.workspace.id, days, { utcOffset }));
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
