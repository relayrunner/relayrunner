import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../app.ts";
import { bearerToken } from "../auth/bearer.ts";
import { createDb, type Db, schema } from "../db/index.ts";
import { verifyMachineToken } from "../machines/machines.ts";
import { AppError } from "@relayrunner/errors";
import { annotate } from "../tracing.ts";

/** The routes a machine calls as itself, behind requireMachine. */
export type MachineEnv = AppEnv & {
  Variables: {
    machine: typeof schema.machine.$inferSelect;
    /** The primary, since a token rotation may have just promoted the pending token. */
    machineDb: Db;
  };
};

// For the routes a machine calls as itself (`relayrunner` and RelayRunner for Mac):
// `Authorization: Bearer rrm_…`. A missing, unknown or revoked token gets a 401.
export const requireMachine = createMiddleware<MachineEnv>(async (c, next) => {
  const db = createDb(c.env.DB);
  const machine = await verifyMachineToken(db, bearerToken(c.req.raw.headers));
  if (!machine) throw new AppError("UNAUTHENTICATED");
  annotate({ "relayrunner.machine_id": machine.id, "user.id": machine.userId });
  c.set("machine", machine);
  c.set("machineDb", db);
  await next();
});
