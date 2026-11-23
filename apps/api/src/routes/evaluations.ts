import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import {
  cancelEvaluation,
  evaluationReport,
  evaluationWorkflows,
  listEvaluations,
  retryEvaluation,
  startEvaluation,
} from "../reports/evaluations.ts";
import { requireFlag } from "../flags.ts";
import { requireUser } from "../middleware/session.ts";
import { requireWorkspace } from "../middleware/workspace.ts";
import { requireManager } from "../auth/roles.ts";
import { AppError } from "@relayrunner/errors";

const StartBody = z.object({
  repositoryId: z.number().int().positive(),
  workflowPath: z.string().trim().min(1).max(512),
  provider: z.string().trim().min(1).max(64),
  vcpus: z.number().int().min(1).max(64),
});

// Provider evaluations (src/reports/evaluations.ts): run a workflow on a provider five times and compare it
// with its recent runs. Any member can look; owners and admins start and stop them, since the runs
// cost money on the provider. Behind the provider-evaluations flag until release.
export const evaluationRoutes = new Hono<AppEnv>()
  .use("*", requireUser, requireWorkspace, requireFlag("provider-evaluations"))
  .get("/workflows", async (c) =>
    c.json({ workflows: await evaluationWorkflows(c.var.db, c.var.workspace.id) }),
  )
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
  .post("/:id/retry", requireManager, async (c) => {
    await retryEvaluation(c.env, c.var.db, c.var.workspace.id, c.req.param("id"));
    return c.json({ ok: true });
  })
  .post("/:id/cancel", requireManager, async (c) => {
    await cancelEvaluation(c.env, c.var.db, c.var.workspace.id, c.req.param("id"));
    return c.json({ ok: true });
  });
