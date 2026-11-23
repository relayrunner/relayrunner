// A typed client for decision models on Workers AI, through the account's AI Gateway. A
// classifier asks typed questions about one input and gets probabilities back, never free text:
//
//   const jobType = defineClassifier({
//     feature: "job_type",
//     version: 1,
//     questions: { kind: { type: "choice", instructions: "…", criteria: { lint: "…", test: "…" } } },
//     state: (job: { name: string; steps: string[] }) => job,
//   });
//   const result = await classify(env, jobType, workspaceId, job);
//   if (result.ok) result.answers.kind.choice; // "lint" | "test"
//
// Every call checks the switches and budgets (settings.ts), reuses a cached answer when it can,
// and records usage. It never throws: callers keep their behavior without AI when it says no.
import { DAY_MS, utcDay } from "../time.ts";
import { and, eq, gt, sql } from "drizzle-orm";
import { createDb, type Db, schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import { sha256Hex } from "../machines/machines.ts";
import { type AiFeature, aiAccess, withinBudget } from "./settings.ts";

/**
 * Cloudflare's Clef-flash: hosted by Cloudflare, which keeps no prompts and trains on none. It
 * takes the same questions as TypeSafe's Jev, which it replaced.
 */
export const DEFAULT_AI_MODEL = "@cf/cloudflare/clef-flash";

// Clef models also want their own name in the input ("clef" or "clef-flash").
const CLEF = "@cf/cloudflare/";
const selector = (model: string) =>
  model.startsWith(CLEF) ? { model: model.slice(CLEF.length) } : {};

const TIMEOUT_MS = 10_000;
const DEFAULT_CACHE_DAYS = 30;

export type NoulQuestion = {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
};
export type ChoiceQuestion<Option extends string = string> = {
  type: "choice";
  instructions: string;
  criteria: Record<Option, string>;
};
/** Levels from lowest to highest. */
export type ScoreQuestion = { type: "score"; instructions: string; criteria: readonly string[] };
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type Questions = Record<string, Question>;

export type Answer<Q extends Question> =
  Q extends ChoiceQuestion<infer Option>
    ? { type: "choice"; choice: Option; confidence: number; probabilities: Record<Option, number> }
    : Q extends ScoreQuestion
      ? { type: "score"; score: number; confidence: number; probabilities: Record<string, number> }
      : /** The probability that the answer is yes. */
        { type: "noul"; noul: number };
export type Answers<Qs extends Questions> = { [Name in keyof Qs]: Answer<Qs[Name]> };

export type Classifier<Input, Qs extends Questions> = {
  feature: AiFeature;
  /** Bump when the questions or state change, so answers cached for the old ones aren't reused. */
  version: number;
  questions: Qs;
  /** What the model evaluates. Keep it small: tokens are the cost. */
  state: (input: Input) => string | Record<string, unknown>;
  /** What makes two inputs the same question, for the cache. Defaults to the state. */
  cacheKey?: (input: Input) => unknown;
  /** How long an answer is reused. 0 never caches. Defaults to 30 days. */
  cacheDays?: number;
  model?: string;
};

export const defineClassifier = <Input, const Qs extends Questions>(
  classifier: Classifier<Input, Qs>,
) => classifier;

/**
 * Why there's no answer. "off": AI, the feature or the workspace is off, or the binding is
 * missing. "budget": past a daily token budget. "rate_limited": too many calls this minute.
 * "failed": the model errored, timed out or answered in an unexpected shape.
 */
export type AiSkip = "off" | "budget" | "rate_limited" | "failed";
export type AiResult<A> = { ok: true; answers: A; cached: boolean } | { ok: false; reason: AiSkip };

export async function classify<Input, Qs extends Questions>(
  env: Env,
  classifier: Classifier<Input, Qs>,
  workspaceId: string,
  input: Input,
  now = Date.now(),
): Promise<AiResult<Answers<Qs>>> {
  const { feature } = classifier;
  if (!env.AI) return { ok: false, reason: "off" };
  const db = createDb(env.DB);
  const log = (outcome: string, extra?: object) =>
    console.log(JSON.stringify({ msg: "ai call", feature, workspaceId, outcome, ...extra }));
  const count = async (counts: UsageCounts) => {
    await usageUpsert(db, workspaceId, feature, counts, now);
  };

  try {
    // The switches first, so turning AI off also stops cached answers.
    const limits = await aiAccess(db, workspaceId, feature, now);
    if (!limits) return skip("off");
    const model = classifier.model ?? DEFAULT_AI_MODEL;
    const state = classifier.state(input);
    const cacheDays = classifier.cacheDays ?? DEFAULT_CACHE_DAYS;
    const key = cacheDays
      ? await aiCacheKey([
          feature,
          classifier.version,
          model,
          workspaceId,
          classifier.cacheKey ? classifier.cacheKey(input) : state,
        ])
      : null;
    const hit = key && (await readCache(db, key, now));
    if (hit) {
      await count({ cacheHits: 1 });
      log("cached");
      return { ok: true, answers: hit as Answers<Qs>, cached: true };
    }
    if (!(await withinBudget(db, workspaceId, limits, now))) return skip("budget");
    if (env.AI_LIMITER && !(await env.AI_LIMITER.limit({ key: workspaceId })).success) {
      return skip("rate_limited");
    }

    const response = unwrap(
      await env.AI.run(
        model,
        { ...selector(model), state, questions: classifier.questions },
        {
          gateway: {
            id: env.AI_GATEWAY_ID,
            // The gateway would otherwise keep each prompt and answer in its logs. Prompts can
            // hold log lines, and we promise not to keep those.
            collectLog: false,
            metadata: { workspace: workspaceId, feature },
            requestTimeoutMs: TIMEOUT_MS,
          },
        },
      ),
    );
    const usage = response.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    const tokens = {
      inputTokens: Number(usage?.input_tokens ?? 0),
      outputTokens: Number(usage?.output_tokens ?? 0),
    };
    const answers = readAnswers(classifier.questions, response.answers);
    if (!answers) {
      await count({ failures: 1, ...tokens });
      log("unexpected answer");
      return { ok: false, reason: "failed" };
    }
    await db.batch([
      usageUpsert(db, workspaceId, feature, { calls: 1, ...tokens }, now),
      ...(key ? [cacheUpsert(db, key, workspaceId, feature, answers, now, cacheDays)] : []),
    ]);
    log("answered", tokens);
    return { ok: true, answers, cached: false };
  } catch (error) {
    await count({ failures: 1 }).catch(() => undefined);
    log("failed", { error: String(error) });
    return { ok: false, reason: "failed" };
  }

  async function skip(reason: Exclude<AiSkip, "failed">): Promise<AiResult<Answers<Qs>>> {
    if (reason !== "off") await count({ limited: 1 });
    log(reason);
    return { ok: false, reason };
  }
}

type ModelResponse = { answers?: unknown; usage?: unknown };

/**
 * The model's response body. Partner models like Jev answer as `{ state: "Completed", result }`
 * through the binding, while Cloudflare's Clef models answer with the body itself.
 */
function unwrap(response: unknown): ModelResponse {
  const body = (response ?? {}) as ModelResponse & { result?: unknown };
  return body.answers === undefined && body.result && typeof body.result === "object"
    ? (body.result as ModelResponse)
    : body;
}

/** The model's answers, if there's one of the right type for every question. */
function readAnswers<Qs extends Questions>(questions: Qs, value: unknown): Answers<Qs> | null {
  if (!value || typeof value !== "object") return null;
  const answers = value as Record<string, { type?: unknown } | undefined>;
  for (const [name, question] of Object.entries(questions)) {
    const answer = answers[name];
    if (answer?.type !== question.type) return null;
    const number = (answer as Record<string, unknown>)[question.type];
    if (question.type !== "choice" && typeof number !== "number") return null;
  }
  return answers as Answers<Qs>;
}

/**
 * A SHA-256 hex digest of `parts` as canonical JSON (object keys sorted), for ai_cache. Callers
 * should strip what makes equal questions look different, like timestamps and ids, before this.
 */
export const aiCacheKey = (parts: unknown) => sha256Hex(canonicalJson(parts));

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function readCache(db: Db, key: string, now: number): Promise<unknown> {
  const [row] = await db
    .select({ answers: schema.aiCache.answers })
    .from(schema.aiCache)
    .where(and(eq(schema.aiCache.key, key), gt(schema.aiCache.expiresAt, new Date(now))));
  return row ? JSON.parse(row.answers) : null;
}

function cacheUpsert(
  db: Db,
  key: string,
  workspaceId: string,
  feature: AiFeature,
  answers: unknown,
  now: number,
  days: number,
) {
  const values = { answers: JSON.stringify(answers), expiresAt: new Date(now + days * DAY_MS) };
  return db
    .insert(schema.aiCache)
    .values({ key, workspaceId, feature, ...values })
    .onConflictDoUpdate({ target: schema.aiCache.key, set: values });
}

/** The counters on an ai_usage_day row. */
export const AI_USAGE_COUNTERS = [
  "calls",
  "cacheHits",
  "limited",
  "failures",
  "inputTokens",
  "outputTokens",
] as const;
type UsageCounts = Partial<Record<(typeof AI_USAGE_COUNTERS)[number], number>>;

/** Adds to today's (UTC) usage row for a workspace and feature. */
function usageUpsert(
  db: Db,
  workspaceId: string,
  feature: AiFeature,
  counts: UsageCounts,
  now: number,
) {
  const usage = schema.aiUsageDay;
  return db
    .insert(usage)
    .values({ day: new Date(utcDay(now)), workspaceId, feature, ...counts })
    .onConflictDoUpdate({
      target: [usage.day, usage.workspaceId, usage.feature],
      set: Object.fromEntries(
        AI_USAGE_COUNTERS.map((c) => [c, sql`${usage[c]} + ${counts[c] ?? 0}`]),
      ),
    });
}
