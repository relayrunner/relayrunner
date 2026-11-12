import { LEGAL_VERSIONS } from "@relayrunner/activity";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { createDb, schema } from "../db/index.ts";
import { requireUser } from "../middleware/session.ts";
import {
  isNotificationType,
  notificationSettings,
  notificationTypesFor,
  setNotification,
} from "../notifications.ts";

const NotificationBody = z.object({ enabled: z.boolean() });

// The versions the dashboard showed, so the record is what the person actually read.
const LegalBody = z.object({ terms: z.string(), privacy: z.string() });

export const meRoutes = new Hono<AppEnv>()
  // The signed-in user. For an agent token, also the workspace and scopes it was granted.
  .get("/", requireUser, (c) =>
    c.json({ user: c.var.user, ...(c.var.agent && { agent: c.var.agent }) }),
  )
  // The emails the user can turn on or off (src/notifications.ts), and whether each is on.
  .get("/notifications", requireUser, async (c) =>
    c.json({ notifications: await notificationSettings(createDb(c.env.DB), c.var.user!) }),
  )
  .put("/notifications/:type", requireUser, async (c) => {
    const type = c.req.param("type");
    if (!isNotificationType(type) || !notificationTypesFor(c.var.user!).includes(type)) {
      return c.json({ error: "not_found" }, 404);
    }
    const body = NotificationBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_body" }, 400);
    await setNotification(createDb(c.env.DB), c.var.user!.id, type, body.data.enabled);
    return c.json({ type, enabled: body.data.enabled });
  })
  // Agreeing to the Terms of Service and Privacy Policy (apps/web/src/routes/agree.tsx). Only the
  // current versions: a page left open across a change gets `outdated` and shows the new ones.
  .post("/legal", requireUser, async (c) => {
    const parsed = LegalBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_body" }, 400);
    if (
      parsed.data.terms !== LEGAL_VERSIONS.terms ||
      parsed.data.privacy !== LEGAL_VERSIONS.privacy
    ) {
      return c.json({ error: "outdated" }, 409);
    }
    const agreed = {
      termsVersion: LEGAL_VERSIONS.terms,
      privacyVersion: LEGAL_VERSIONS.privacy,
      legalAgreedAt: new Date(),
    };
    await createDb(c.env.DB)
      .update(schema.user)
      .set(agreed)
      .where(eq(schema.user.id, c.var.user!.id));
    // The versions ride the session's cookie cache (auth.ts): re-read it so the dashboard sees
    // the agreement right away instead of in up to five minutes.
    const { headers } = await c.var.auth.api.getSession({
      headers: c.req.raw.headers,
      query: { disableCookieCache: true },
      returnHeaders: true,
    });
    for (const cookie of headers.getSetCookie()) c.header("set-cookie", cookie, { append: true });
    return c.json(agreed);
  });
