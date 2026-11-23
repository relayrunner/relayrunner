import { JOB_LOG_CHOICES } from "@relayrunner/activity";
import { AppError } from "@relayrunner/errors";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { requireUser } from "../middleware/session.ts";
import { requireWorkspace } from "../middleware/workspace.ts";
import { requireManager } from "../auth/roles.ts";
import {
  bucketView,
  deleteBucket,
  saveBucket,
  testBucketSettings,
} from "../telemetry/bucket-settings.ts";
import { destinationChanged, logsChanged } from "./telemetry.ts";

const SaveBody = z.object({
  endpoint: z.string().trim().min(1).max(2048),
  bucket: z.string().trim().min(1).max(63),
  region: z.string().trim().max(50),
  prefix: z.string().trim().max(512),
  accessKeyId: z.string().trim().max(256).optional(),
  secretAccessKey: z.string().trim().max(1024).optional(),
  logs: z.enum(JOB_LOG_CHOICES),
});

// Settings → Telemetry → Bucket: where the workspace archives job logs. Any member can look; owners
// and admins change it, and a change to which logs go there, the bucket or the key shows in
// Activity. The secret access key never comes back.
export const logBucketRoutes = new Hono<AppEnv>()
  .use("*", requireUser, requireWorkspace)
  .get("/", async (c) => c.json(await bucketView(c.var.db, c.var.workspace.id)))
  .use("*", requireManager)
  .put("/", async (c) => {
    const parsed = SaveBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new AppError("BUCKET_INVALID");
    const workspaceId = c.var.workspace.id;
    const result = await saveBucket(c.env, c.var.db, workspaceId, c.var.user!.id, parsed.data);
    if (!result.ok) throw new AppError(result.error, { message: result.message });
    const { bucket } = result;
    await Promise.all([
      logsChanged(c, "settings.log_bucket", result.previousLogs, bucket.logs),
      destinationChanged(c, "bucket", bucket.bucket, result.changes),
    ]);
    return c.json(result.bucket);
  })
  .delete("/", async (c) => {
    const { bucket, previousLogs } = await deleteBucket(c.var.db, c.var.workspace.id);
    await logsChanged(c, "settings.log_bucket", previousLogs, bucket.logs);
    return c.json(bucket);
  })
  // Write a small test object with the saved settings.
  .post("/test", async (c) => {
    const result = await testBucketSettings(c.env, c.var.db, c.var.workspace.id);
    if (!result) throw new AppError("BUCKET_NOT_CONFIGURED");
    return c.json(result);
  });
