import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { requireUser } from "../middleware/session.ts";
import { requireWorkspace } from "../middleware/workspace.ts";
import { requireManager } from "../roles.ts";
import { tokenStorage } from "./providers.ts";
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
});

// Settings → Telemetry: where the workspace sends its CI traces. Any member can look; owners and
// admins change it. Header values never come back.
export const telemetryRoutes = new Hono<AppEnv>()
  .use("*", requireUser, requireWorkspace)
  .get("/", async (c) => c.json(await telemetryView(c.var.db, c.var.workspace.id)))
  .use("*", requireManager, tokenStorage)
  .put("/", async (c) => {
    const parsed = SaveBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_body" }, 400);
    const result = await saveTelemetry(
      c.env,
      c.var.db,
      c.var.workspace.id,
      c.var.user!.id,
      parsed.data,
    );
    if (!result.ok) return c.json({ error: result.error, message: result.message }, 400);
    return c.json(result.telemetry);
  })
  .delete("/", async (c) => c.json(await deleteTelemetry(c.var.db, c.var.workspace.id)))
  // Send a small test trace with the saved settings.
  .post("/test", async (c) => {
    const result = await testTelemetry(c.env, c.var.db, c.var.workspace.id);
    if (!result) return c.json({ error: "not_configured" }, 404);
    return c.json(result);
  });
