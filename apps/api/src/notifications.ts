/**
 * Which emails a person gets. Every type here is on until they turn it off in Account settings;
 * src/db/schema.ts notificationSetting keeps only what they changed. Emails left out of this list
 * always send: the welcome email (sent once, before anyone could choose) and a machine taken over
 * (it's how you learn someone else has your machine's token).
 */
import { and, eq, isNull, or } from "drizzle-orm";
import { schema, type Db } from "./db/index.ts";
import { isOperator } from "./roles.ts";

export const NOTIFICATION_TYPES = {
  // To the person who approved the machine in the CLI.
  "machine-connected": { operator: false },
  // To every operator: the team's alerts, which went to one shared inbox before.
  feedback: { operator: true },
  "dead-letter-alert": { operator: true },
  "price-check": { operator: true },
} as const;

export type NotificationType = keyof typeof NOTIFICATION_TYPES;

export function isNotificationType(type: string): type is NotificationType {
  return Object.hasOwn(NOTIFICATION_TYPES, type);
}

/** The types this user can choose: operator alerts only for operators. */
export function notificationTypesFor(user: { role?: string | null }) {
  const operator = isOperator(user);
  return (Object.keys(NOTIFICATION_TYPES) as NotificationType[]).filter(
    (type) => operator || !NOTIFICATION_TYPES[type].operator,
  );
}

/** Each type the user can choose, and whether it's on. */
export async function notificationSettings(db: Db, user: { id: string; role?: string | null }) {
  const off = await turnedOff(db, user.id);
  return notificationTypesFor(user).map((type) => ({
    type,
    operator: NOTIFICATION_TYPES[type].operator,
    enabled: !off.has(type),
  }));
}

export async function setNotification(
  db: Db,
  userId: string,
  type: NotificationType,
  enabled: boolean,
) {
  const updatedAt = new Date();
  await db
    .insert(schema.notificationSetting)
    .values({ userId, type, enabled, updatedAt })
    .onConflictDoUpdate({
      target: [schema.notificationSetting.userId, schema.notificationSetting.type],
      set: { enabled, updatedAt },
    });
}

/** Whether the user wants this email. Defaults to yes. */
export async function wantsEmail(db: Db, userId: string, type: NotificationType) {
  return !(await turnedOff(db, userId)).has(type);
}

/** Email addresses of the operators who haven't turned this alert off. */
export async function operatorRecipients(db: Db, type: NotificationType) {
  const rows = await db
    .select({ email: schema.user.email })
    .from(schema.user)
    .leftJoin(
      schema.notificationSetting,
      and(
        eq(schema.notificationSetting.userId, schema.user.id),
        eq(schema.notificationSetting.type, type),
      ),
    )
    .where(
      and(
        eq(schema.user.role, "operator"),
        or(
          isNull(schema.notificationSetting.enabled),
          eq(schema.notificationSetting.enabled, true),
        ),
      ),
    );
  return rows.map((row) => row.email);
}

async function turnedOff(db: Db, userId: string) {
  const rows = await db
    .select({ type: schema.notificationSetting.type })
    .from(schema.notificationSetting)
    .where(
      and(
        eq(schema.notificationSetting.userId, userId),
        eq(schema.notificationSetting.enabled, false),
      ),
    );
  return new Set(rows.map((row) => row.type));
}
