import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { agentBearer, agentMayCall, agentSession } from "../agent-auth.ts";
import { createAuth } from "../auth.ts";
import type { AppEnv } from "../app.ts";

// Builds this request's auth instance and attaches the signed-in user and session, or null.
// An agent access token (agent-auth.ts) attaches its user and c.var.agent instead of a session, and
// may only reach the read-only agent routes.
export const attachSession = createMiddleware<AppEnv>(async (c, next) => {
  const url = new URL(c.req.url);
  const auth = createAuth(c.env, waitUntil(c), url.hostname);
  c.set("auth", auth);
  const token = agentBearer(c.req.raw.headers);
  if (token) {
    const result = await agentSession(c.env, auth, token);
    if (!result) return c.json({ error: "invalid_token" }, 401);
    if (!agentMayCall(c.req.method, url.pathname)) {
      return c.json({ error: "not_allowed_for_agents" }, 403);
    }
    c.set("user", result.user);
    c.set("session", null);
    c.set("agent", result.agent);
    return next();
  }
  const result = await auth.api.getSession({ headers: c.req.raw.headers });
  c.set("user", result?.user ?? null);
  c.set("session", result?.session ?? null);
  await next();
});

// The request's waitUntil, or undefined where Hono has no ExecutionContext (app.request in tests).
export function waitUntil(c: Context<AppEnv>) {
  try {
    const ctx = c.executionCtx;
    return (promise: Promise<unknown>) => ctx.waitUntil(promise);
  } catch {
    return undefined;
  }
}

export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.var.user) return c.json({ error: "unauthorized" }, 401);
  await next();
});
