/**
 * Which emails a person gets. Every type here is on until they turn it off in Account settings;
 * src/db/schema.ts notificationSetting keeps only what they changed. Emails left out of this list
 * always send: the welcome email (sent once, before anyone could choose) and a machine taken over
 * (it's how you learn someone else has your machine's token).
 */
import { and, eq } from "drizzle-orm";
import { createDb, schema, type Db } from "./db/index.ts";
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
  return notificationTypesFor(user).map((type) => ({ type, enabled: !off.has(type) }));
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
  const [row] = await db
    .select({ enabled: schema.notificationSetting.enabled })
    .from(schema.notificationSetting)
    .where(
      and(eq(schema.notificationSetting.userId, userId), eq(schema.notificationSetting.type, type)),
    )
    .limit(1);
  return row?.enabled ?? true;
}

/** Email addresses of the operators who want this alert. */
export async function operatorRecipients(d1: D1Database, type: NotificationType) {
  const db = createDb(d1);
  const operators = await db
    .select({ id: schema.user.id, email: schema.user.email })
    .from(schema.user)
    .where(eq(schema.user.role, "operator"));
  if (!operators.length) return [];
  const off = await db
    .select({ userId: schema.notificationSetting.userId })
    .from(schema.notificationSetting)
    .where(
      and(eq(schema.notificationSetting.type, type), eq(schema.notificationSetting.enabled, false)),
    );
  const optedOut = new Set(off.map((row) => row.userId));
  return operators.filter((op) => !optedOut.has(op.id)).map((op) => op.email);
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
