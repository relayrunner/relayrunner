// Who may call the AI model, and how much (src/ai/classify.ts): a global switch and budget that
// operators set in Admin › AI, and a row per workspace. Everything is off until an operator turns
// on both the global switch and the workspace.
import { eq, sql } from "drizzle-orm";
import { cachedRead } from "../d1-cache.ts";
import { type Db, schema } from "../db/index.ts";
import { utcDay } from "../job-timings.ts";

/** What a model call is for. Each can be turned off globally or per workspace. */
export const AI_FEATURES = {
  job_type: "Classify jobs by what they do, such as lint, tests or a build",
  failure_cause: "Classify why a job failed, such as a flaky test or a lint error",
  test: "Test calls from Admin › AI",
} as const;
export type AiFeature = keyof typeof AI_FEATURES;
export const AI_FEATURE_IDS = Object.keys(AI_FEATURES) as AiFeature[];

export type AiGlobalSettings = {
  enabled: boolean;
  features: AiFeature[];
  /** Input plus output tokens a day, per workspace unless its row says otherwise. */
  workspaceDailyTokens: number;
  /** Input plus output tokens a day, across all workspaces. */
  dailyTokens: number;
};

// About $0.08 and $2 a day at $0.042 per million input tokens.
export const AI_DEFAULTS: AiGlobalSettings = {
  enabled: false,
  features: [],
  workspaceDailyTokens: 2_000_000,
  dailyTokens: 50_000_000,
};

const GLOBAL_ID = "global";
const isFeature = (id: string): id is AiFeature => Object.hasOwn(AI_FEATURES, id);

type WorkspaceAi = { features: AiFeature[] | null; dailyTokens: number | null };
type AiSettings = { global: AiGlobalSettings; workspaces: Map<string, WorkspaceAi> };

// Read on every call, so reused for a minute per isolate: the global row and every workspace that
// has AI on (operators turn it on one by one, so there are few). An operator's change applies at
// once in the isolate that made it, and within a minute everywhere else. If D1 can't be read, AI
// is off.
const settings = cachedRead(
  "ai settings",
  async (db): Promise<AiSettings> => {
    const [[row], workspaces] = await Promise.all([
      db.select().from(schema.aiSetting).where(eq(schema.aiSetting.id, GLOBAL_ID)),
      db
        .select()
        .from(schema.workspaceAiSetting)
        .where(eq(schema.workspaceAiSetting.enabled, true)),
    ]);
    return {
      global: row
        ? {
            enabled: row.enabled,
            features: row.features.filter(isFeature),
            workspaceDailyTokens: row.workspaceDailyTokens,
            dailyTokens: row.dailyTokens,
          }
        : AI_DEFAULTS,
      workspaces: new Map(
        workspaces.map((w) => [
          w.workspaceId,
          { features: w.features?.filter(isFeature) ?? null, dailyTokens: w.dailyTokens },
        ]),
      ),
    };
  },
  () => ({ global: AI_DEFAULTS, workspaces: new Map() }),
);

export const readAiSettings = async (db: Db) => (await settings.load(db)).global;

/** Drops this isolate's cached settings, after an operator changes them. */
export const forgetAiSettings = () => settings.forget();

export async function saveAiSettings(db: Db, values: AiGlobalSettings, by: string) {
  const row = { ...values, updatedBy: by, updatedAt: new Date() };
  await db
    .insert(schema.aiSetting)
    .values({ id: GLOBAL_ID, ...row })
    .onConflictDoUpdate({ target: schema.aiSetting.id, set: row });
  forgetAiSettings();
}

/** Today's token limits for a workspace: its own and everyone's together. */
export type AiLimits = { workspace: number; all: number };

/**
 * The limits `workspaceId` makes `feature` calls under, or null when the global switch, the
 * feature or the workspace is off. The budget is a separate check (withinBudget), since cached
 * answers don't spend it.
 */
export async function aiAccess(
  db: Db,
  workspaceId: string,
  feature: AiFeature,
  now = Date.now(),
): Promise<AiLimits | null> {
  const { global, workspaces } = await settings.load(db, now);
  const workspace = workspaces.get(workspaceId);
  if (!global.enabled || !global.features.includes(feature) || !workspace) return null;
  if (workspace.features && !workspace.features.includes(feature)) return null;
  return {
    workspace: workspace.dailyTokens ?? global.workspaceDailyTokens,
    all: global.dailyTokens,
  };
}

/** Whether today's (UTC) tokens are under both limits. */
export async function withinBudget(db: Db, workspaceId: string, limits: AiLimits, now: number) {
  const usage = schema.aiUsageDay;
  const tokens = sql`${usage.inputTokens} + ${usage.outputTokens}`;
  const [row] = await db
    .select({
      mine: sql<number>`coalesce(sum(case when ${usage.workspaceId} = ${workspaceId} then ${tokens} end), 0)`,
      total: sql<number>`coalesce(sum(${tokens}), 0)`,
    })
    .from(usage)
    .where(eq(usage.day, new Date(utcDay(now))));
  return Number(row?.mine ?? 0) < limits.workspace && Number(row?.total ?? 0) < limits.all;
}
