import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { requireUser } from "../middleware/session.ts";
import { requireWorkspace } from "../middleware/workspace.ts";
import { signalsReport } from "../signals.ts";
import { AppError } from "@relayrunner/errors";

const SignalsQuery = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
});

// The Signals page: what is making the workspace's CI slow, costly or busier than it needs to be,
// over the last ?days=N days (default 30), from the hourly rollup (src/signals.ts).
export const signalRoutes = new Hono<AppEnv>().get(
  "/",
  requireUser,
  requireWorkspace,
  async (c) => {
    const parsed = SignalsQuery.safeParse(c.req.query());
    if (!parsed.success) throw new AppError("INVALID_REQUEST");
    return c.json(await signalsReport(c.var.db, c.var.workspace.id, parsed.data.days));
  },
);
