import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import { requireUser } from "../middleware/session.ts";

// The signed-in user. For an agent token, also the workspace and scopes it was granted.
export const meRoutes = new Hono<AppEnv>().get("/", requireUser, (c) =>
  c.json({ user: c.var.user, ...(c.var.agent && { agent: c.var.agent }) }),
);
