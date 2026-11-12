import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../app.ts";
import { createDb } from "../db/index.ts";

// D1 read replication (https://developers.cloudflare.com/d1/best-practices/read-replication/).
// Dashboard requests read through a D1 session, so their reads can go to a nearby replica. The
// session's bookmark rides back in a cookie, and the next request starts from it, so the dashboard
// always sees its own writes. Everything else (auth, the CLI's machine routes, Durable Objects,
// queues and crons) keeps using `createDb(env.DB)` on the primary, because each reads rows another
// request has just written.
export const BOOKMARK_COOKIE = "rr_d1_bookmark";

/** A database for this request that reads through a D1 session, saving its bookmark afterwards. */
export function sessionDb(c: Context<AppEnv>) {
  const session = c.env.DB.withSession(getCookie(c, BOOKMARK_COOKIE) ?? "first-unconstrained");
  return {
    db: createDb(session),
    /** Saves where the session got to, after the handler ran its queries. */
    saveBookmark() {
      const bookmark = session.getBookmark();
      if (!bookmark) return;
      setCookie(c, BOOKMARK_COOKIE, bookmark, {
        path: "/api",
        httpOnly: true,
        secure: new URL(c.req.url).protocol === "https:",
        sameSite: "Lax",
        maxAge: 60 * 60,
      });
    },
  };
}
