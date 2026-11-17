// Who may call the AI model, and how much (src/ai/classify.ts): a global switch and budget that
// operators set in Admin › AI, each workspace's own opt-in (its AI settings page), and operator
// overrides per workspace. Nothing runs until an operator turns on the global switch and a feature,
// and an owner or admin opts the workspace in.
import { eq, isNotNull, sql } from "drizzle-orm";
import { cachedRead } from "../d1-cache.ts";
import { type Db, schema } from "../db/index.ts";
import { utcDay } from "../job-timings.ts";
import { purgeAiAnswers } from "../retention.ts";

/** What a model call is for. Each can be turned off globally or, by operators, per workspace. */
export const AI_FEATURES = {
  job_type: "Classify jobs by what they do, such as lint, tests or a build",
  failure_cause: "Classify why a job failed, such as a flaky test or a lint error",
  retry_decision:
    "Let failure causes decide automatic retries: retry flaky jobs, skip broken setups",
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

// About $0.08 and $1.90 a day at $0.038 per million input tokens.
export const AI_DEFAULTS: AiGlobalSettings = {
  enabled: false,
  features: [],
  workspaceDailyTokens: 2_000_000,
  dailyTokens: 50_000_000,
};

const GLOBAL_ID = "global";
const isFeature = (id: string): id is AiFeature => Object.hasOwn(AI_FEATURES, id);

/** An operator's override for one workspace (workspace_ai_setting). No row allows it. */
type Override = { enabled: boolean | null; features: string[] | null };

/** The features that run for a workspace: those on globally, less any its override takes away. */
const featuresOf = (global: AiGlobalSettings, override?: Override): AiFeature[] =>
  !global.enabled || override?.enabled === false
    ? []
    : global.features.filter((id) => !override?.features || override.features.includes(id));

type WorkspaceAi = { features: AiFeature[]; dailyTokens: number | null };
type AiSettings = { global: AiGlobalSettings; workspaces: Map<string, WorkspaceAi> };

// Read on every call, so reused for a minute per isolate: the global row and every opted-in
// workspace. A change applies at once in the isolate that made it, and within a minute everywhere
// else. If D1 can't be read, AI is off.
const settings = cachedRead(
  "ai settings",
  async (db): Promise<AiSettings> => {
    const [[row], workspaces] = await Promise.all([
      db.select().from(schema.aiSetting).where(eq(schema.aiSetting.id, GLOBAL_ID)),
      db
        .select({
          workspaceId: schema.workspace.id,
          enabled: schema.workspaceAiSetting.enabled,
          features: schema.workspaceAiSetting.features,
          dailyTokens: schema.workspaceAiSetting.dailyTokens,
        })
        .from(schema.workspace)
        .leftJoin(
          schema.workspaceAiSetting,
          eq(schema.workspaceAiSetting.workspaceId, schema.workspace.id),
        )
        .where(isNotNull(schema.workspace.aiOptInAt)),
    ]);
    const global = row
      ? {
          enabled: row.enabled,
          features: row.features.filter(isFeature),
          workspaceDailyTokens: row.workspaceDailyTokens,
          dailyTokens: row.dailyTokens,
        }
      : AI_DEFAULTS;
    return {
      global,
      workspaces: new Map(
        workspaces.map((w) => [
          w.workspaceId,
          { features: featuresOf(global, w), dailyTokens: w.dailyTokens },
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

/** The features that run for `workspaceId` once it opts in, less test calls. */
export async function aiFeaturesFor(db: Db, workspaceId: string): Promise<AiFeature[]> {
  const [global, [override]] = await Promise.all([
    readAiSettings(db),
    db
      .select()
      .from(schema.workspaceAiSetting)
      .where(eq(schema.workspaceAiSetting.workspaceId, workspaceId)),
  ]);
  return featuresOf(global, override).filter((id) => id !== "test");
}

/**
 * Opts a workspace in to AI features, or out. Opting out also deletes the answers AI saved for it
 * (job types and cached answers), so the dashboard looks as it did before. Applies everywhere
 * within a minute.
 */
export async function setAiOptIn(db: Db, workspaceId: string, enabled: boolean, by: string | null) {
  const workspace = schema.workspace;
  if (enabled) {
    await db
      .update(workspace)
      .set({ aiOptInAt: new Date(), aiOptInBy: by })
      .where(eq(workspace.id, workspaceId));
  } else {
    await db.batch([
      db
        .update(workspace)
        .set({ aiOptInAt: null, aiOptInBy: null })
        .where(eq(workspace.id, workspaceId)),
      ...purgeAiAnswers(db, workspaceId),
    ]);
  }
  forgetAiSettings();
}

/** Today's token limits for a workspace: its own and everyone's together. */
export type AiLimits = { workspace: number; all: number };

/**
 * The limits `workspaceId` makes `feature` calls under, or null when the global switch or the
 * feature is off, or the workspace hasn't opted in or is blocked. The budget is a separate check
 * (withinBudget), since cached answers don't spend it.
 */
export async function aiAccess(
  db: Db,
  workspaceId: string,
  feature: AiFeature,
  now = Date.now(),
): Promise<AiLimits | null> {
  const { global, workspaces } = await settings.load(db, now);
  const workspace = workspaces.get(workspaceId);
  if (!workspace?.features.includes(feature)) return null;
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
