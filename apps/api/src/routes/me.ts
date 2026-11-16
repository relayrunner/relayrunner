import { LEGAL_VERSIONS } from "@relayrunner/activity";
import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
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
import { AppError } from "@relayrunner/errors";

const NotificationBody = z.object({ enabled: z.boolean() });

// The versions the dashboard showed, so the record is what the person actually read.
const LegalBody = z.object({ terms: z.string(), privacy: z.string() });

// An IANA zone such as "Europe/Berlin", or null to follow the browser's.
const TimeZoneBody = z.object({ timeZone: z.string().max(64).nullable() });

/** Whether this runtime knows `zone` as a time zone. */
function isTimeZone(zone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Re-reads the session past its cookie cache (auth.ts) and passes on the fresh cookie, so the
 * dashboard sees a change to the user's fields right away instead of in up to five minutes.
 */
async function refreshSessionCookie(c: Context<AppEnv>) {
  const { headers } = await c.var.auth.api.getSession({
    headers: c.req.raw.headers,
    query: { disableCookieCache: true },
    returnHeaders: true,
  });
  for (const cookie of headers.getSetCookie()) c.header("set-cookie", cookie, { append: true });
}

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
      throw new AppError("NOT_FOUND");
    }
    const body = NotificationBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) throw new AppError("INVALID_REQUEST");
    await setNotification(createDb(c.env.DB), c.var.user!.id, type, body.data.enabled);
    return c.json({ type, enabled: body.data.enabled });
  })
  // Agreeing to the Terms of Service and Privacy Policy (apps/web/src/routes/agree.tsx). Only the
  // current versions: a page left open across a change gets `outdated` and shows the new ones.
  .post("/legal", requireUser, async (c) => {
    const parsed = LegalBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new AppError("INVALID_REQUEST");
    if (
      parsed.data.terms !== LEGAL_VERSIONS.terms ||
      parsed.data.privacy !== LEGAL_VERSIONS.privacy
    ) {
      throw new AppError("LEGAL_TERMS_OUTDATED");
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
    await refreshSessionCookie(c);
    return c.json(agreed);
  })
  // The time zone the dashboard shows times and days in, or null for the browser's.
  .put("/time-zone", requireUser, async (c) => {
    const parsed = TimeZoneBody.safeParse(await c.req.json().catch(() => null));
    const timeZone = parsed.success ? parsed.data.timeZone : undefined;
    if (timeZone === undefined || (timeZone !== null && !isTimeZone(timeZone))) {
      throw new AppError("INVALID_REQUEST");
    }
    await createDb(c.env.DB)
      .update(schema.user)
      .set({ timeZone })
      .where(eq(schema.user.id, c.var.user!.id));
    await refreshSessionCookie(c);
    return c.json({ timeZone });
  });
