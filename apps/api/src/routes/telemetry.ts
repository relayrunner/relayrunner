import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { requireUser } from "../middleware/session.ts";
import { requireWorkspace } from "../middleware/workspace.ts";
import { requireManager } from "../roles.ts";
import { JOB_LOG_CHOICES, type JobLogChoice } from "@relayrunner/activity";
import { AppError } from "@relayrunner/errors";
import { changeSetting } from "../changes.ts";
import {
  deleteTelemetry,
  saveTelemetry,
  telemetryView,
  testTelemetry,
} from "../telemetry/settings.ts";

// An HTTP header name (RFC 9110 token).
const HeaderName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/);

const SaveBody = z.object({
  endpoint: z.string().trim().min(1).max(2048),
  headers: z
    .array(z.object({ name: HeaderName, value: z.string().trim().max(4096).optional() }))
    .max(20)
    .refine((headers) => {
      const names = headers.map((h) => h.name.toLowerCase());
      return new Set(names).size === names.length && !names.includes("content-type");
    }),
  serviceName: z.string().trim().max(200),
  enabled: z.boolean(),
  logs: z.enum(JOB_LOG_CHOICES).optional(),
});

// Notes in Activity when a save or removal changed which jobs' logs go out. The settings are already
// saved, so there's nothing left to write.
function logsChanged(c: Context<AppEnv>, previous: JobLogChoice, logs: JobLogChoice) {
  return changeSetting(c, c.var.workspace.id, {
    previous,
    next: logs,
    write: async () => {},
    event: { type: "settings.job_logs", data: { logs } },
  });
}

// Settings → Telemetry: where the workspace sends its CI traces and job logs. Any member can look;
// owners and admins change it, and a change to which logs go out shows in Activity. Header values
// never come back.
export const telemetryRoutes = new Hono<AppEnv>()
  .use("*", requireUser, requireWorkspace)
  .get("/", async (c) => c.json(await telemetryView(c.var.db, c.var.workspace.id)))
  .use("*", requireManager)
  .put("/", async (c) => {
    const parsed = SaveBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      throw new AppError("INVALID_REQUEST", {
        message: "Check the header names: letters, numbers and dashes, each used once.",
      });
    const workspaceId = c.var.workspace.id;
    const result = await saveTelemetry(c.env, c.var.db, workspaceId, c.var.user!.id, parsed.data);
    if (!result.ok) throw new AppError(result.error, { message: result.message });
    await logsChanged(c, result.previousLogs, result.telemetry.logs);
    return c.json(result.telemetry);
  })
  .delete("/", async (c) => {
    const { telemetry, previousLogs } = await deleteTelemetry(c.var.db, c.var.workspace.id);
    await logsChanged(c, previousLogs, telemetry.logs);
    return c.json(telemetry);
  })
  // Send a small test trace with the saved settings.
  .post("/test", async (c) => {
    const result = await testTelemetry(c.env, c.var.db, c.var.workspace.id);
    if (!result) throw new AppError("TELEMETRY_NOT_CONFIGURED");
    return c.json(result);
  });
