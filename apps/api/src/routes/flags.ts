import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import { evaluateFlags } from "../flags.ts";
import { requireUser } from "../middleware/session.ts";
import { requireWorkspace } from "../middleware/workspace.ts";

// The dashboard's feature flags (src/flags.ts): each flag's value for the signed-in user in their
// active workspace. The dashboard can't read Flagship itself, since that needs an API token in the
// browser, so it reads them here.
export const flagRoutes = new Hono<AppEnv>().get("/", requireUser, requireWorkspace, async (c) =>
  c.json(await evaluateFlags(c)),
);
