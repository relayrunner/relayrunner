import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { requireUser } from "../middleware/session.ts";
import { requireWorkspace } from "../middleware/workspace.ts";
import { DEFAULT_DAYS, listRuns, MAX_DAYS, runJobs } from "../runs.ts";

const DaysQuery = z.object({
  days: z.coerce.number().int().min(1).max(MAX_DAYS).default(DEFAULT_DAYS),
});

const Id = z.coerce.number().int().positive();
const RunParams = z.object({ repositoryId: Id, runId: Id, runAttempt: Id });

// The Runs page: the workspace's workflow runs active in the last ?days=N days (default 7), newest
// first. /:repositoryId/:runId/:runAttempt/jobs is one run attempt's jobs, for its expanded row.
export const runRoutes = new Hono<AppEnv>()
  .get("/", requireUser, requireWorkspace, async (c) => {
    const parsed = DaysQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid_query" }, 400);
    return c.json(await listRuns(c.var.db, c.var.workspace.id, parsed.data.days));
  })
  .get("/:repositoryId/:runId/:runAttempt/jobs", requireUser, requireWorkspace, async (c) => {
    const parsed = RunParams.safeParse(c.req.param());
    if (!parsed.success) return c.json({ error: "invalid_run" }, 400);
    return c.json(await runJobs(c.var.db, c.var.workspace.id, parsed.data));
  });
