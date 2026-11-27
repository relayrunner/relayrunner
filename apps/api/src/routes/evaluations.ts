import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import {
  cancelEvaluation,
  evaluationReport,
  evaluationWorkflows,
  isEvaluable,
  listEvaluations,
  recentEvaluations,
  retryEvaluation,
  startEvaluation,
} from "../reports/evaluations.ts";
import { importing, runHistoryState, withGitHubWorkflows } from "../ingest/run-history.ts";
import { requireUser } from "../middleware/session.ts";
import { requireWorkspace } from "../middleware/workspace.ts";
import { canManage, requireManager } from "../auth/roles.ts";
import { jobFailure } from "../reports/job-failures.ts";
import { workspaceProviderApps } from "../providers/provider-apps.ts";
import { AppError } from "@relayrunner/errors";
import { AUTO_SIZES, labelForSize, providerPlans } from "@relayrunner/providers";
import { currentProviders } from "../providers/provider-catalog.ts";

const StartBody = z.object({
  repositoryId: z.number().int().positive(),
  workflowPath: z.string().trim().min(1).max(512),
  provider: z.string().trim().min(1).max(64),
  vcpus: z.number().int().min(1).max(64),
  workflowName: z.string().trim().max(256).nullish(),
});

const Id = z.coerce.number().int().positive();

// Provider evaluations (src/reports/evaluations.ts): run a workflow on a provider five times and compare it
// with its recent runs. Any member can look; owners and admins start and stop them, since the runs
// cost money on the provider.
//
// The handlers need c.var.user, c.var.workspace and c.var.role. The dashboard reaches them with its
// session and active workspace (evaluationRoutes); `relayrunner eval` with its machine token, as the
// machine's owner in the workspace it names (routes/machines/machine-evaluations.ts). Both start the
// same evaluation, so each can follow one the other started.
export const evaluationHandlers = new Hono<AppEnv>()
  .get("/workflows", async (c) => {
    const { workspace } = c.var;
    const workflows = await evaluationWorkflows(c.var.db, workspace.id);
    const history = workspace.installationId
      ? await runHistoryState(c.var.db, workspace.installationId)
      : null;
    // Still importing: add what GitHub lists, so a workflow can be picked before its runs are in.
    if (workspace.installationId && importing(history))
      return c.json({
        workflows: await withGitHubWorkflows(c.env, c.var.db, workspace.installationId, workflows),
      });
    return c.json({ workflows });
  })
  // The new installation's run history import (src/ingest/run-history.ts), which the dashboard polls.
  // Null when the workspace never had one.
  .get("/history", async (c) => {
    const { installationId } = c.var.workspace;
    return c.json({
      history: installationId ? await runHistoryState(c.var.db, installationId) : null,
    });
  })
  // The providers an evaluation can run on, with the sizes each offers and where to sign up, for
  // `relayrunner eval`'s pick (the dashboard has these in its own bundle).
  .get("/providers", (c) =>
    c.json({
      providers: currentProviders()
        .filter((p) => isEvaluable(p.id) && p.status !== "off")
        .map((p) => ({
          id: p.id,
          name: p.name,
          connectUrl: providerPlans(p.id)?.connectUrl ?? null,
          sizes: evaluationSizes(p.id),
        })),
    }),
  )
  // Whether the provider's GitHub App is on the workspace's account, for the Connect step:
  // `installed` is null when GitHub can't tell (a personal account), and the person confirms it.
  .get("/provider-app", async (c) => {
    const provider = c.req.query("provider");
    if (!provider) throw new AppError("INVALID_REQUEST");
    const { installed, account } = await workspaceProviderApps(c.env, c.var.db, c.var.workspace.id);
    return c.json({
      installed: installed === null ? null : (installed as string[]).includes(provider),
      account,
      workspace: { id: c.var.workspace.id, name: c.var.workspace.name, slug: c.var.workspace.slug },
      canStart: canManage(c.var.role),
    });
  })
  // A provider's evaluations from the last 30 days, with their headline numbers, for its page.
  .get("/recent", async (c) => {
    const provider = c.req.query("provider");
    if (!provider) throw new AppError("INVALID_REQUEST");
    return c.json({
      evaluations: await recentEvaluations(c.var.db, c.var.workspace.id, provider),
    });
  })
  .get("/", async (c) =>
    c.json({
      evaluations: await listEvaluations(
        c.var.db,
        c.var.workspace.id,
        c.req.query("provider") || undefined,
      ),
    }),
  )
  .post("/", requireManager, async (c) => {
    const body = StartBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) throw new AppError("INVALID_REQUEST");
    const { workspace } = c.var;
    const id = await startEvaluation(c.env, c.var.db, {
      ...body.data,
      workspaceId: workspace.id,
      installationId: workspace.installationId,
      userId: c.var.user?.id ?? null,
    });
    return c.json({ id }, 201);
  })
  .get("/:id", async (c) =>
    c.json(await evaluationReport(c.var.db, c.var.workspace.id, c.req.param("id"))),
  )
  // Why one of an evaluation's failed jobs failed, as History shows it.
  .get("/:id/jobs/:jobId/failure", async (c) => {
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
  .post("/:id/retry", requireManager, async (c) => {
    await retryEvaluation(c.env, c.var.db, c.var.workspace.id, c.req.param("id"));
    return c.json({ ok: true });
  })
  .post("/:id/cancel", requireManager, async (c) => {
    await cancelEvaluation(c.env, c.var.db, c.var.workspace.id, c.req.param("id"));
    return c.json({ ok: true });
  });

/** The dashboard's: the session's user in its active workspace. */
export const evaluationRoutes = new Hono<AppEnv>()
  .use("*", requireUser, requireWorkspace)
  .route("/", evaluationHandlers);

/** The sizes a provider offers for an evaluation, with the label each gets, as the dashboard lists them. */
function evaluationSizes(provider: string) {
  return AUTO_SIZES.flatMap((vcpus) => {
    const label = labelForSize(provider, vcpus, 0);
    return label ? [{ vcpus, label }] : [];
  }).filter((size, i, all) => all.findIndex((other) => other.label === size.label) === i);
}
