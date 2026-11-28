import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { requireUser } from "../middleware/session.ts";
import { requireWorkspace } from "../middleware/workspace.ts";
import { recentJobs } from "../reports/job-times.ts";
import { workflowJobSteps } from "../github/actions-api.ts";
import { appInstallationToken } from "../github/github-app.ts";
import { jobSource, listRuns, liveJobs, runJobs } from "../reports/runs.ts";
import { parseRunFilters, runFilterOptions } from "../reports/run-filters.ts";
import { jobFailure, runFailures } from "../reports/job-failures.ts";
import { jobWindow } from "./job-times.ts";
import { AppError } from "@relayrunner/errors";

const Id = z.coerce.number().int().positive();
const RunParams = z.object({ repositoryId: Id, runId: Id, runAttempt: Id });

// The History page: the workspace's workflow runs in a window (?from=&to=, or the last ?days=N,
// default 14), newest first; ?repo=&workflow= narrows it to one workflow. It and /jobs also take the
// run filters (src/reports/run-filters.ts); /filters is what each can be set to over the window.
// /live is the jobs still going, running or queued, for the Runners page.
// /:repositoryId/:runId/:runAttempt/jobs is one run attempt's jobs, for its expanded row. /jobs is
// every job a runner finished in a window (as above, default 14 days), newest first, for the Jobs view.
// /jobs/:jobId/steps is one job's steps, read from GitHub when its detail opens.
// /jobs/:jobId/failure is why one failed job failed, with the end of its log, for its detail.
// /:repositoryId/:runId/:runAttempt/failures is why the attempt's jobs failed, with log excerpts
// read from GitHub, for agents. Both answer only someone who can read the repo on GitHub.
export const runRoutes = new Hono<AppEnv>()
  .get("/", requireUser, requireWorkspace, async (c) => {
    // `repo` and `workflow` together narrow it to one workflow, for its panel.
    const { repo, workflow } = c.req.query();
    const only = repo && workflow ? { repository: repo, workflow } : undefined;
    const query = c.req.query();
    return c.json(
      await listRuns(c.var.db, c.var.workspace.id, jobWindow(query), only, parseRunFilters(query)),
    );
  })
  .get("/filters", requireUser, requireWorkspace, async (c) =>
    c.json(await runFilterOptions(c.var.db, c.var.workspace.id, jobWindow(c.req.query()))),
  )
  .get("/live", requireUser, requireWorkspace, async (c) =>
    c.json(await liveJobs(c.var.db, c.var.workspace.id)),
  )
  .get("/jobs", requireUser, requireWorkspace, async (c) => {
    const query = c.req.query();
    return c.json(
      await recentJobs(c.var.db, c.var.workspace.id, jobWindow(query), parseRunFilters(query)),
    );
  })
  .get("/jobs/:jobId/steps", requireUser, requireWorkspace, async (c) => {
    const jobId = Id.safeParse(c.req.param("jobId"));
    if (!jobId.success) throw new AppError("INVALID_REQUEST");
    const source = await jobSource(c.var.db, c.var.workspace.id, jobId.data);
    if (!source) throw new AppError("NOT_FOUND");
    const token = await appInstallationToken(c.env, source.installationId);
    return c.json({ steps: await workflowJobSteps(token, source.repository, jobId.data) });
  })
  .get("/jobs/:jobId/failure", requireUser, requireWorkspace, async (c) => {
    const jobId = Id.safeParse(c.req.param("jobId"));
    if (!jobId.success) throw new AppError("INVALID_REQUEST");
    const failure = await jobFailure(
      c.var.db,
      c.env,
      c.var.workspace.id,
      c.var.user!.id,
      jobId.data,
    );
    if (!failure) throw new AppError("NOT_FOUND");
    return c.json(failure);
  })
  .get("/:repositoryId/:runId/:runAttempt/jobs", requireUser, requireWorkspace, async (c) => {
    const parsed = RunParams.safeParse(c.req.param());
    if (!parsed.success) throw new AppError("INVALID_REQUEST");
    return c.json(await runJobs(c.var.db, c.var.workspace.id, parsed.data));
  })
  .get("/:repositoryId/:runId/:runAttempt/failures", requireUser, requireWorkspace, async (c) => {
    const parsed = RunParams.safeParse(c.req.param());
    if (!parsed.success) throw new AppError("INVALID_REQUEST");
    return c.json(
      await runFailures(c.var.db, c.env, c.var.workspace.id, c.var.user!.id, parsed.data),
    );
  });
