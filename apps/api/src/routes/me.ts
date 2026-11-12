import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { createDb } from "../db/index.ts";
import { requireUser } from "../middleware/session.ts";
import {
  isNotificationType,
  notificationSettings,
  notificationTypesFor,
  setNotification,
} from "../notifications.ts";

const NotificationBody = z.object({ enabled: z.boolean() });

// The signed-in user. For an agent token, also the workspace and scopes it was granted.
export const meRoutes = new Hono<AppEnv>()
  .get("/", requireUser, (c) =>
    c.json({ user: c.var.user, ...(c.var.agent && { agent: c.var.agent }) }),
  )
  // The emails the user can turn on or off (src/notifications.ts), and whether each is on.
  .get("/notifications", requireUser, async (c) =>
    c.json({ notifications: await notificationSettings(createDb(c.env.DB), c.var.user!) }),
  )
  .put("/notifications/:type", requireUser, async (c) => {
    const type = c.req.param("type");
    if (!isNotificationType(type) || !notificationTypesFor(c.var.user!).includes(type)) {
      return c.json({ error: "not_found" }, 404);
    }
    const body = NotificationBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_body" }, 400);
    await setNotification(createDb(c.env.DB), c.var.user!.id, type, body.data.enabled);
    return c.json({ type, enabled: body.data.enabled });
  });
