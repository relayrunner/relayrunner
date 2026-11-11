import { ACTIVITY_FILTERS, ACTIVITY_RESULTS } from "@relayrunner/activity";
import { Hono } from "hono";
import { z } from "zod";
import { activityOptions, listActivity } from "../activity.ts";
import type { AppEnv } from "../app.ts";
import { requireUser } from "../middleware/session.ts";
import { requireWorkspace } from "../middleware/workspace.ts";

const ActivityQuery = z.object({
  // An event id: the nextBefore of the previous page.
  before: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  // Only one kind of event: 'job', 'check', 'machine' or 'member'.
  filter: z.enum(ACTIVITY_FILTERS).optional(),
  // ms since the epoch.
  since: z.coerce.number().int().nonnegative().max(8.64e15).optional(),
  repository: z.string().min(1).max(200).optional(),
  result: z.enum(ACTIVITY_RESULTS).optional(),
  machine: z.string().min(1).max(100).optional(),
});

// The Activity page: the active workspace's audit log, newest first. Page with
// ?before=<nextBefore from the previous page>, narrow with ?filter=job|check|machine|member,
// ?since, ?repository, ?result and ?machine. /options lists the repos and machines to pick from.
export const activityRoutes = new Hono<AppEnv>()
  .get("/", requireUser, requireWorkspace, async (c) => {
    const parsed = ActivityQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid_query" }, 400);
    return c.json(await listActivity(c.var.db, c.var.workspace.id, parsed.data));
  })
  .get("/options", requireUser, requireWorkspace, async (c) =>
    c.json(await activityOptions(c.var.db, c.var.workspace.id)),
  );
