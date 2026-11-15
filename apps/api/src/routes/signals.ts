import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import { requireUser } from "../middleware/session.ts";
import { requireWorkspace } from "../middleware/workspace.ts";
import { signalsReport } from "../signals.ts";
import { parseDays } from "./days.ts";
import { AppError } from "@relayrunner/errors";

// The Signals page: what is making the workspace's CI slow, costly or busier than it needs to be,
// over the last ?days=N days (default 30), from the hourly rollup (src/signals.ts). ?breakdown=0
// leaves out the Breakdown, for agents that only want the signals.
export const signalRoutes = new Hono<AppEnv>().get(
  "/",
  requireUser,
  requireWorkspace,
  async (c) => {
    const days = parseDays(c.req.query());
    if (days === null) throw new AppError("INVALID_REQUEST");
    const breakdown = c.req.query("breakdown") !== "0";
    return c.json(await signalsReport(c.var.db, c.var.workspace.id, days, { breakdown }));
  },
);
