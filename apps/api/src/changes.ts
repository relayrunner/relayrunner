import type { ActivityEvent } from "@relayrunner/activity";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { type NewActivityEvent, recordEvent } from "./activity.ts";
import type { AppEnv } from "./app.ts";
import { schema } from "./db/index.ts";

// Settings changes in the Activity log, from the dashboard or an agent (agent-auth.ts).

/** Who made a change and where: the signed-in user, through the dashboard or an agent's app. */
export interface ChangeActor {
  userId: string;
  via: "dashboard" | "agent";
  // The agent's app as it registered itself, such as "Claude". Null for the dashboard.
  agent: string | null;
}

export async function changeActor(c: Context<AppEnv>): Promise<ChangeActor> {
  const { agent, user, db } = c.var;
  if (!agent) return { userId: user!.id, via: "dashboard", agent: null };
  const [client] = await db
    .select({ name: schema.oauthClient.name })
    .from(schema.oauthClient)
    .where(eq(schema.oauthClient.clientId, agent.clientId))
    .limit(1);
  return { userId: user!.id, via: "agent", agent: client?.name || "An agent" };
}

type SettingsEvent = Extract<ActivityEvent, { type: `settings.${string}` }>;

/** Logs a settings change in the workspace's Activity, with who made it and where. */
export async function recordChange<T extends SettingsEvent["type"]>(
  c: Context<AppEnv>,
  workspaceId: string,
  type: T,
  data: Omit<Extract<SettingsEvent, { type: T }>["data"], "via" | "agent">,
) {
  const { userId, ...via } = await changeActor(c);
  await recordEvent(c.var.db, {
    workspaceId,
    actorUserId: userId,
    type,
    data: { ...data, ...via },
    // recordEvent checks the data against the type's schema.
  } as unknown as NewActivityEvent);
}
