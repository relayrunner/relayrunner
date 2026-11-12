import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { DEFAULT_DAYS, jobRuns, MAX_DAYS, machineJobTimes } from "../job-times.ts";
import { requireUser } from "../middleware/session.ts";
import { requireWorkspace } from "../middleware/workspace.ts";
import { withCatalog } from "../provider-catalog.ts";
import { performanceReport } from "../runs.ts";

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

// The Performance page: how long each workflow and job usually takes on each runner environment over
// the last ?days=N days (default 14). /runs is one job's runs, for its detail chart. /machines is
// each machine's typical job, for the Runners page.
export const jobTimesRoutes = new Hono<AppEnv>()
  .get("/", requireUser, requireWorkspace, withCatalog, async (c) => {
    const parsed = DaysQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid_query" }, 400);
    return c.json(await performanceReport(c.var.db, c.var.workspace.id, parsed.data.days));
  })
  .get("/runs", requireUser, requireWorkspace, withCatalog, async (c) => {
    const parsed = RunsQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid_query" }, 400);
    const { days, repositoryId, workflow, name, matrix } = parsed.data;
    const job = { repositoryId, workflow: workflow ?? null, name, matrix: matrix === "true" };
    return c.json(await jobRuns(c.var.db, c.var.workspace.id, job, days));
  })
  .get("/machines", requireUser, requireWorkspace, withCatalog, async (c) => {
    const parsed = DaysQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid_query" }, 400);
    return c.json(await machineJobTimes(c.var.db, c.var.workspace.id, parsed.data.days));
  });
