import { getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../app.ts";
import { createDb } from "../db/index.ts";

// D1 read replication (https://developers.cloudflare.com/d1/best-practices/read-replication/).
// c.var.db reads through a D1 session, so reads can go to a nearby replica. The session's bookmark
// rides back in a cookie and the next request starts from it, so the dashboard always sees its own
// writes. Code that reads rows another request has just written (auth, the CLI's machine routes,
// Durable Objects, queues and crons) uses `createDb(env.DB)` on the primary instead.
export const BOOKMARK_COOKIE = "rr_d1_bookmark";

export const d1Session = createMiddleware<AppEnv>(async (c, next) => {
  const sent = getCookie(c, BOOKMARK_COOKIE);
  const session = c.env.DB.withSession(sent ?? "first-unconstrained");
  c.set("db", createDb(session));
  await next();
  const bookmark = session.getBookmark();
  if (!bookmark || bookmark === sent) return;
  setCookie(c, BOOKMARK_COOKIE, bookmark, {
    path: "/api",
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    maxAge: 60 * 60,
  });
});
