import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { requireUser } from "../middleware/session.ts";
import { requireWorkspace } from "../middleware/workspace.ts";
import { withCatalog } from "../provider-catalog.ts";
import { recentJobs } from "../job-times.ts";
import { appInstallationToken, workflowJobSteps } from "../github-app.ts";
import { jobSource, listRuns, runJobs } from "../runs.ts";
import { Days } from "./job-times.ts";

const Id = z.coerce.number().int().positive();
const JobsQuery = z.object({ days: Days });
const RunParams = z.object({ repositoryId: Id, runId: Id, runAttempt: Id });

// The History page: the workspace's workflow runs from the last 14 days, newest first.
// /:repositoryId/:runId/:runAttempt/jobs is one run attempt's jobs, for its expanded row. /jobs is
// every job a runner finished in the last ?days=N days, newest first, for the Jobs view.
// /jobs/:jobId/steps is one job's steps, read from GitHub when its detail opens.
export const runRoutes = new Hono<AppEnv>()
  .get("/", requireUser, requireWorkspace, withCatalog, async (c) =>
    c.json(await listRuns(c.var.db, c.var.workspace.id)),
  )
  .get("/jobs", requireUser, requireWorkspace, withCatalog, async (c) => {
    const parsed = JobsQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid_query" }, 400);
    return c.json(await recentJobs(c.var.db, c.var.workspace.id, parsed.data.days));
  })
  .get("/jobs/:jobId/steps", requireUser, requireWorkspace, async (c) => {
    const jobId = Id.safeParse(c.req.param("jobId"));
    if (!jobId.success) return c.json({ error: "invalid_job" }, 400);
    const source = await jobSource(c.var.db, c.var.workspace.id, jobId.data);
    if (!source) return c.json({ error: "not_found" }, 404);
    const token = await appInstallationToken(c.env, source.installationId);
    return c.json({ steps: await workflowJobSteps(token, source.repository, jobId.data) });
  })
  .get(
    "/:repositoryId/:runId/:runAttempt/jobs",
    requireUser,
    requireWorkspace,
    withCatalog,
    async (c) => {
      const parsed = RunParams.safeParse(c.req.param());
      if (!parsed.success) return c.json({ error: "invalid_run" }, 400);
      return c.json(await runJobs(c.var.db, c.var.workspace.id, parsed.data));
    },
  );
