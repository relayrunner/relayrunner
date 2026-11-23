/**
 * Operator admin for AI model calls (src/ai): the global switch, features and budgets, which
 * workspaces turned it off, a block or override per workspace, recent usage, and a test call. Needs Cloudflare Access (app.ts) and an
 * operator session (admin.ts). Changes apply at once in this isolate and within a minute in others.
 */
import { DAY_MS, utcDay } from "../time.ts";
import { AppError } from "@relayrunner/errors";
import { eq, gte, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { classify, DEFAULT_AI_MODEL, defineClassifier } from "../ai/classify.ts";
import {
  AI_FEATURE_IDS,
  AI_FEATURES,
  forgetAiSettings,
  readAiSettings,
  saveAiSettings,
} from "../ai/settings.ts";
import type { AppEnv } from "../app.ts";
import { createDb, schema } from "../db/index.ts";
import { audit } from "../middleware/admin.ts";

const USAGE_DAYS = 7;
const features = z.array(z.enum(AI_FEATURE_IDS)).transform((list) => [...new Set(list)]);
const tokens = z.number().int().min(0).max(1_000_000_000);

const GlobalBody = z.object({
  enabled: z.boolean(),
  features,
  workspaceDailyTokens: tokens,
  dailyTokens: tokens,
});
const WorkspaceBody = z.object({
  enabled: z.boolean(),
  // Null allows every feature that's on globally.
  features: features.nullable(),
  // Null uses the global per-workspace budget.
  dailyTokens: tokens.nullable(),
});
const TestBody = z.object({
  workspaceId: z.string().min(1),
  text: z.string().trim().min(1).max(500),
});

// One yes/no question that exercises the whole path: switches, budget, gateway and usage.
const testCall = defineClassifier({
  feature: "test",
  version: 1,
  questions: {
    ci: { type: "noul", instructions: "Is this text about CI, builds or tests?" },
  },
  state: (text: string) => text,
  cacheDays: 0,
});

export const adminAiRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const db = createDb(c.env.DB);
    const usage = schema.aiUsageDay;
    const today = utcDay(Date.now());
    const [settings, workspaces, rows] = await Promise.all([
      readAiSettings(db),
      db
        .select({
          id: schema.workspace.id,
          name: schema.workspace.name,
          logo: schema.workspace.logo,
          offAt: schema.workspace.aiOffAt,
          enabled: schema.workspaceAiSetting.enabled,
          features: schema.workspaceAiSetting.features,
          dailyTokens: schema.workspaceAiSetting.dailyTokens,
        })
        .from(schema.workspace)
        .leftJoin(
          schema.workspaceAiSetting,
          eq(schema.workspaceAiSetting.workspaceId, schema.workspace.id),
        )
        .orderBy(schema.workspace.name),
      db
        .select({
          workspaceId: usage.workspaceId,
          calls: sql<number>`sum(${usage.calls})`,
          cacheHits: sql<number>`sum(${usage.cacheHits})`,
          limited: sql<number>`sum(${usage.limited})`,
          failures: sql<number>`sum(${usage.failures})`,
          tokensToday: sql<number>`sum(case when ${usage.day} = ${today} then ${usage.inputTokens} + ${usage.outputTokens} else 0 end)`,
        })
        .from(usage)
        .where(gte(usage.day, new Date(today - (USAGE_DAYS - 1) * DAY_MS)))
        .groupBy(usage.workspaceId),
    ]);
    const usageOf = new Map(rows.map(({ workspaceId, ...row }) => [workspaceId, row]));
    return c.json({
      binding: Boolean(c.env.AI),
      gateway: c.env.AI_GATEWAY_ID,
      model: DEFAULT_AI_MODEL,
      features: AI_FEATURE_IDS.map((id) => ({ id, label: AI_FEATURES[id] })),
      settings,
      usageDays: USAGE_DAYS,
      workspaces: workspaces.map(({ enabled, features, dailyTokens, ...workspace }) => ({
        ...workspace,
        // enabled is never null in a row, so null means the workspace has none.
        setting: enabled === null ? null : { enabled, features, dailyTokens },
        usage: usageOf.get(workspace.id) ?? null,
      })),
    });
  })
  .put("/", async (c) => {
    const parsed = GlobalBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new AppError("INVALID_REQUEST");
    await saveAiSettings(createDb(c.env.DB), parsed.data, c.var.user!.id);
    audit(c, "ai settings changed", parsed.data);
    return c.json({ settings: parsed.data });
  })
  .put("/workspaces/:id", async (c) => {
    const parsed = WorkspaceBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new AppError("INVALID_REQUEST");
    const workspaceId = c.req.param("id");
    const db = createDb(c.env.DB);
    const [workspace] = await db
      .select({ id: schema.workspace.id })
      .from(schema.workspace)
      .where(eq(schema.workspace.id, workspaceId));
    if (!workspace) throw new AppError("NOT_FOUND");
    const values = { ...parsed.data, updatedBy: c.var.user!.id, updatedAt: new Date() };
    await db
      .insert(schema.workspaceAiSetting)
      .values({ workspaceId, ...values })
      .onConflictDoUpdate({ target: schema.workspaceAiSetting.workspaceId, set: values });
    forgetAiSettings();
    audit(c, "workspace ai settings changed", { workspaceId, ...parsed.data });
    return c.json({ setting: parsed.data });
  })
  // Runs one question for a workspace through every check, the gateway and usage logging.
  .post("/test", async (c) => {
    const parsed = TestBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new AppError("INVALID_REQUEST");
    const started = Date.now();
    const result = await classify(c.env, testCall, parsed.data.workspaceId, parsed.data.text);
    return c.json({ result, ms: Date.now() - started });
  });
