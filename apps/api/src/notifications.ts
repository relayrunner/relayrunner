/**
 * Which emails a person gets, chosen in Account settings. Each type starts at its `on` default;
 * src/db/schema.ts notificationSetting keeps only what someone changed. Emails left out of this
 * list always send: the welcome email (sent once, before anyone could choose) and a machine taken
 * over (it's how you learn someone else has your machine's token).
 */
import { and, eq, isNull, or } from "drizzle-orm";
import { schema, type Db } from "./db/index.ts";
import { isOperator } from "./roles.ts";

export const NOTIFICATION_TYPES = {
  // To the person who approved the machine in the CLI.
  "machine-connected": { operator: false, on: true },
  // Operator alerts always go to the team inbox (FEEDBACK_EMAIL, OPERATOR_ALERT_EMAIL). An
  // operator can also get a copy at their own address; off by default, since the team inbox
  // forwards to operators already.
  feedback: { operator: true, on: false },
  "dead-letter-alert": { operator: true, on: false },
  "price-check": { operator: true, on: false },
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
  const chosen = await choices(db, user.id);
  return notificationTypesFor(user).map((type) => ({
    type,
    operator: NOTIFICATION_TYPES[type].operator,
    enabled: chosen.get(type) ?? NOTIFICATION_TYPES[type].on,
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

/** Whether the user wants this email. */
export async function wantsEmail(db: Db, userId: string, type: NotificationType) {
  return (await choices(db, userId)).get(type) ?? NOTIFICATION_TYPES[type].on;
}

/** Email addresses of the operators who want their own copy of this alert. */
export async function operatorRecipients(db: Db, type: NotificationType) {
  const setting = schema.notificationSetting;
  const rows = await db
    .select({ email: schema.user.email })
    .from(schema.user)
    .leftJoin(setting, and(eq(setting.userId, schema.user.id), eq(setting.type, type)))
    .where(
      and(
        eq(schema.user.role, "operator"),
        NOTIFICATION_TYPES[type].on
          ? or(isNull(setting.enabled), eq(setting.enabled, true))
          : eq(setting.enabled, true),
      ),
    );
  return rows.map((row) => row.email);
}

/** What the user chose for each type they changed. */
async function choices(db: Db, userId: string) {
  const rows = await db
    .select({ type: schema.notificationSetting.type, enabled: schema.notificationSetting.enabled })
    .from(schema.notificationSetting)
    .where(eq(schema.notificationSetting.userId, userId));
  return new Map(rows.map((row) => [row.type, row.enabled]));
}
