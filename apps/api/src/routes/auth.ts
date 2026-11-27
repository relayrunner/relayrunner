import { AppError } from "@relayrunner/errors";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../app.ts";

// Better Auth endpoints anyone can call without signing in, each capped per IP by AUTH_LIMITER:
// starting a sign-in, the CLI's device code and its polling, and agents registering and trading
// codes for tokens. Better Auth's own limiter keeps its counts in one isolate's memory, which does
// next to nothing on Workers. The cap sits well above what a person or a polling CLI (one request
// every 5 seconds) sends, so it only stops scripts.
const LIMITED_PATHS = [
  /^\/api\/auth\/sign-in\//,
  /^\/api\/auth\/sign-up\//,
  /^\/api\/auth\/device\/(code|token)$/,
  /^\/api\/auth\/oauth2\/(register|token)$/,
];

const limitAuth = createMiddleware<AppEnv>(async (c, next) => {
  const limiter = c.env.AUTH_LIMITER;
  const path = new URL(c.req.url).pathname;
  if (limiter && c.req.method === "POST" && LIMITED_PATHS.some((pattern) => pattern.test(path))) {
    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    const { success } = await limiter.limit({ key: `${ip}:${path}` });
    if (!success) throw new AppError("RATE_LIMITED", { retryAfter: 60 });
  }
  await next();
});

// Better Auth serves its own routes (sign-in, callback, session, sign-out) under /api/auth/*.
// Its built-in error page is never shown: errors redirect to the dashboard's sign-in page
// (auth.ts onAPIError), and an old /api/auth/error link goes there too, keeping its query.
export const authRoutes = new Hono<AppEnv>()
  .get("/error", (c) => c.redirect(`/login${new URL(c.req.url).search}`))
  .use("/*", limitAuth)
  .on(["GET", "POST"], "/*", (c) => c.var.auth.handler(c.req.raw));
