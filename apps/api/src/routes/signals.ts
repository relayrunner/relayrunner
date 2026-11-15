import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { requireUser } from "../middleware/session.ts";
import { requireWorkspace } from "../middleware/workspace.ts";
import {
  type SignalFilter,
  type SignalId,
  SIGNALS,
  signalRuns,
  signalsReport,
} from "../signals.ts";
import { parseDays } from "./days.ts";
import { AppError } from "@relayrunner/errors";

const value = z.string().trim().min(1).max(300).optional();

// The page's filter: ?person=, ?repo=, ?workflow=, ?branch= and ?trigger= (an event name, or
// "rerun"), each a Breakdown value.
const FilterQuery = z.object({
  person: value,
  repo: value,
  workflow: value,
  branch: value,
  trigger: value,
});

function parseFilter(query: Record<string, string>): SignalFilter {
  const parsed = FilterQuery.safeParse(query);
  if (!parsed.success) throw new AppError("INVALID_REQUEST");
  const { repo, ...rest } = parsed.data;
  return { ...rest, repository: repo };
}

function days(query: Record<string, string>) {
  const parsed = parseDays(query);
  if (parsed === null) throw new AppError("INVALID_REQUEST");
  return parsed;
}

// One signal row: ?signal=, with the row's ?in= repo and ?subject=.
const RowQuery = z.object({
  signal: z.enum(Object.keys(SIGNALS) as [SignalId, ...SignalId[]]),
  in: z.string().min(1).max(300),
  subject: z.string().min(1).max(500),
});

// The Signals page: what is making the workspace's CI slow, costly or busier than it needs to be,
// over the last ?days=N days (default 30), from the hourly rollup (src/signals.ts). ?breakdown=0
// leaves out the Breakdown, for agents that only want the signals. A filter narrows the page to
// its runs over at most the last 30 days, and adds its trend.
export const signalRoutes = new Hono<AppEnv>()
  .get("/", requireUser, requireWorkspace, async (c) => {
    const query = c.req.query();
    const breakdown = query.breakdown !== "0";
    const filter = parseFilter(query);
    return c.json(
      await signalsReport(c.var.db, c.var.workspace, days(query), { breakdown, filter }),
    );
  })
  // The runs behind one signal row, newest first, within the page's filter.
  .get("/runs", requireUser, requireWorkspace, async (c) => {
    const query = c.req.query();
    const row = RowQuery.safeParse(query);
    if (!row.success) throw new AppError("INVALID_REQUEST");
    const { signal, in: repository, subject } = row.data;
    return c.json(
      await signalRuns(
        c.var.db,
        c.var.workspace.installationId,
        { signal, repository, subject },
        days(query),
        { filter: parseFilter(query) },
      ),
    );
  });
