import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../app.ts";
import { createDb } from "../db/index.ts";
import { verifyMachineToken } from "../machines/machines.ts";
import { AppError } from "@relayrunner/errors";
import { annotate } from "../tracing.ts";

// For the routes a machine calls as itself (`relayrunner` and RelayRunner for Mac):
// `Authorization: Bearer rrm_…`. A missing, unknown or revoked token gets a 401. Reads the primary,
// since a token rotation may have just promoted the pending token.
export const requireMachine = createMiddleware<AppEnv>(async (c, next) => {
  const token = c.req.header("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  const machine = await verifyMachineToken(createDb(c.env.DB), token);
  if (!machine) throw new AppError("UNAUTHENTICATED");
  annotate({ "relayrunner.machine_id": machine.id, "user.id": machine.userId });
  c.set("machine", machine);
  await next();
});
