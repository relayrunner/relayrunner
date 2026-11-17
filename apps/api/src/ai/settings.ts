// Who may call the AI model, and how much (src/ai/classify.ts): a global switch and budget that
// operators set in Admin › AI, each workspace's own switch (Settings › General), and operator
// overrides per workspace. Workspaces start on: nothing runs until an operator turns on the global
// switch and a feature, and an owner or admin can turn it off for their workspace.
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

type WorkspaceOverride = Override & { dailyTokens: number | null };
type AiSettings = {
  global: AiGlobalSettings;
  /** Workspaces whose owner or admin turned AI off. */
  off: Set<string>;
  overrides: Map<string, WorkspaceOverride>;
};

// Read on every call, so reused for a minute per isolate: the global row, the workspaces that
// turned AI off and the operators' overrides (both few, since AI is on by default). A change
// applies at once in the isolate that made it, and within a minute everywhere else. If D1 can't be
// read, AI is off.
const settings = cachedRead(
  "ai settings",
  async (db): Promise<AiSettings> => {
    const [[row], off, overrides] = await Promise.all([
      db.select().from(schema.aiSetting).where(eq(schema.aiSetting.id, GLOBAL_ID)),
      db
        .select({ id: schema.workspace.id })
        .from(schema.workspace)
        .where(isNotNull(schema.workspace.aiOffAt)),
      db.select().from(schema.workspaceAiSetting),
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
      off: new Set(off.map((w) => w.id)),
      overrides: new Map(overrides.map((o) => [o.workspaceId, o])),
    };
  },
  () => ({ global: AI_DEFAULTS, off: new Set(), overrides: new Map() }),
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

/**
 * Turns AI on or off for a workspace. It's on until an owner or admin turns it off, which also
 * deletes the answers AI saved for it (job types and cached answers), so the dashboard looks as it
 * would without AI. Applies everywhere within a minute.
 */
export async function setWorkspaceAi(
  db: Db,
  workspaceId: string,
  enabled: boolean,
  by: string | null,
) {
  const workspace = schema.workspace;
  if (enabled) {
    await db
      .update(workspace)
      .set({ aiOffAt: null, aiOffBy: null })
      .where(eq(workspace.id, workspaceId));
  } else {
    await db.batch([
      db
        .update(workspace)
        .set({ aiOffAt: new Date(), aiOffBy: by })
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
 * feature is off, the workspace turned AI off, or an operator blocked it. The budget is a separate
 * check (withinBudget), since cached answers don't spend it.
 */
export async function aiAccess(
  db: Db,
  workspaceId: string,
  feature: AiFeature,
  now = Date.now(),
): Promise<AiLimits | null> {
  const { global, off, overrides } = await settings.load(db, now);
  const override = overrides.get(workspaceId);
  if (off.has(workspaceId) || !featuresOf(global, override).includes(feature)) return null;
  return {
    workspace: override?.dailyTokens ?? global.workspaceDailyTokens,
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
