import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { FLAG_KEYS, type FlagKey, type Flags } from "@relayrunner/api-types";
import { AppError } from "@relayrunner/errors";
import type { AppEnv } from "./app.ts";
import { isOperator } from "./auth/roles.ts";
import { log } from "./log.ts";

// Feature flags from Cloudflare Flagship, through the FLAGS binding (wrangler.jsonc). The keys
// live in @relayrunner/api-types (FLAG_KEYS), and docs/feature-flags.md covers adding and retiring
// one. Every check goes through this file, so the dashboard and the API agree on a flag's value.
//
// A flag is off unless Flagship says it's on: with no binding (tests, or an env without one), for
// a key the app doesn't have yet, or when evaluation fails. Each flag is evaluated once per
// request and the value kept on the context, as Flagship's best practices advise.

/**
 * Who's asking, for Flagship's targeting rules. `targetingKey` is the user's id, so a percentage
 * rollout puts each person in the same bucket every time. `role` is "operator" for operators
 * (user.role, the people who see Admin), so a rule `role equals "operator"` turns a flag on for
 * them alone, and is left out for everyone else. The workspace attributes let a rule turn a flag on
 * for one workspace, by id or by its GitHub account's login (the slug). Nothing sensitive goes
 * here: no email or names.
 */
export function flagContext(c: Context<AppEnv>) {
  const context: Record<string, string> = {};
  const user = c.var.user;
  if (user) {
    context.targetingKey = user.id;
    context.userId = user.id;
    if (isOperator(user)) context.role = "operator";
  }
  const workspace = c.var.workspace;
  if (workspace) {
    context.workspaceId = workspace.id;
    context.workspaceSlug = workspace.slug;
  }
  return context;
}

/** Whether `key` is on for this request's user and workspace. */
export async function isFlagOn(c: Context<AppEnv>, key: FlagKey): Promise<boolean> {
  const cached = c.var.flags?.[key];
  if (cached !== undefined) return cached;
  const value = await evaluate(c, key);
  c.set("flags", { ...c.var.flags, [key]: value });
  return value;
}

/** Every flag in FLAG_KEYS, evaluated together. */
export async function evaluateFlags(c: Context<AppEnv>): Promise<Flags> {
  const values = await Promise.all(FLAG_KEYS.map((key: FlagKey) => isFlagOn(c, key)));
  return Object.fromEntries(FLAG_KEYS.map((key: FlagKey, i) => [key, values[i]])) as Flags;
}

/**
 * Answers 404 unless `key` is on, so a flagged route looks like it doesn't exist. Run it after
 * requireUser, and after requireWorkspace when workspace rules should apply.
 */
export function requireFlag(key: FlagKey) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (!(await isFlagOn(c, key))) throw new AppError("NOT_FOUND");
    await next();
  });
}

async function evaluate(c: Context<AppEnv>, key: string) {
  const flags = c.env.FLAGS;
  if (!flags) return false;
  try {
    return await flags.getBooleanValue(key, false, flagContext(c));
  } catch (error) {
    // The binding returns the default for known failures; anything else stays off too.
    log.warn("flags.evaluation_failed", "flag evaluation failed", { flag: key, error });
    return false;
  }
}
