import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { agentBearer, agentMayCall, agentSession } from "../auth/agent-auth.ts";
import { createAuth } from "../auth/auth.ts";
import type { AppEnv } from "../app.ts";
import { AppError } from "@relayrunner/errors";
import { annotate } from "../tracing.ts";

// Builds this request's auth instance and attaches the signed-in user and session, or null.
// An agent access token (agent-auth.ts) attaches its user and c.var.agent instead of a session, and
// may only reach the read-only agent routes, at AGENT_LIMITER's rate.
export const attachSession = createMiddleware<AppEnv>(async (c, next) => {
  const url = new URL(c.req.url);
  const auth = createAuth(c.env, waitUntil(c), url.hostname);
  c.set("auth", auth);
  const token = agentBearer(c.req.raw.headers);
  if (token) {
    const result = await agentSession(c.env, auth, token);
    if (!result) throw new AppError("INVALID_TOKEN");
    annotate({ "user.id": result.user.id, "relayrunner.agent_grant_id": result.agent.grantId });
    if (!agentMayCall(c.req.method, url.pathname)) {
      throw new AppError("AGENT_NOT_ALLOWED");
    }
    const limit = await c.env.AGENT_LIMITER?.limit({
      key: `${result.user.id}:${result.agent.grantId}`,
    });
    if (limit && !limit.success) {
      throw new AppError("RATE_LIMITED", { retryAfter: 60 });
    }
    c.set("user", result.user);
    c.set("session", null);
    c.set("agent", result.agent);
    return next();
  }
  const result = await auth.api.getSession({ headers: c.req.raw.headers });
  c.set("user", result?.user ?? null);
  c.set("session", result?.session ?? null);
  annotate({ "user.id": result?.user.id });
  await next();
});

// The request's waitUntil, or undefined where Hono has no ExecutionContext (app.request in tests).
export function waitUntil(c: Pick<Context, "executionCtx">) {
  try {
    const ctx = c.executionCtx;
    return (promise: Promise<unknown>) => ctx.waitUntil(promise);
  } catch {
    return undefined;
  }
}

// Runs `promise` after the response where there's a waitUntil, else waits for it (tests).
export async function inBackground(c: Pick<Context, "executionCtx">, promise: Promise<unknown>) {
  const defer = waitUntil(c);
  if (defer) defer(promise);
  else await promise;
}

export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.var.user) throw new AppError("UNAUTHENTICATED");
  await next();
});
