import { Hono } from "hono";
import type { AppEnv } from "../app.ts";

// Better Auth serves its own routes (sign-in, callback, session, sign-out) under /api/auth/*.
// Its built-in error page is never shown: errors redirect to the dashboard's sign-in page
// (auth.ts onAPIError), and an old /api/auth/error link goes there too, keeping its query.
export const authRoutes = new Hono<AppEnv>()
  .get("/error", (c) => c.redirect(`/login${new URL(c.req.url).search}`))
  .on(["GET", "POST"], "/*", (c) => c.var.auth.handler(c.req.raw));
