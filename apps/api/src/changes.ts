import type { ActivityEvent } from "@relayrunner/activity";
import type { Context } from "hono";
import { type NewActivityEvent, recordEvent } from "./activity.ts";
import { agentClientName } from "./agent-auth.ts";
import type { AppEnv } from "./app.ts";

// Settings changes in the Activity log, from the dashboard or an agent (agent-auth.ts).

/**
 * Who made a change and where: the signed-in user, through the dashboard or an agent. `agent` is
 * the agent's app as it registered itself, such as "Claude".
 */
export interface ChangeActor {
  userId: string;
  via: "dashboard" | "agent";
  agent?: string;
}

export async function changeActor(c: Context<AppEnv>): Promise<ChangeActor> {
  const { agent, user, db } = c.var;
  if (!agent) return { userId: user!.id, via: "dashboard" };
  return {
    userId: user!.id,
    via: "agent",
    agent: (await agentClientName(db, agent.clientId)) || "An agent",
  };
}

type SettingsEvent = Extract<ActivityEvent, { type: `settings.${string}` }>;

/** A settings event without who made it: changeSetting adds that. */
export type SettingsChange = {
  [T in SettingsEvent["type"]]: {
    type: T;
    data: Omit<Extract<SettingsEvent, { type: T }>["data"], "via" | "agent">;
  };
}[SettingsEvent["type"]];

/**
 * Saves a workspace setting with `write` and logs `event` in its Activity, with who made it and
 * where. Saving what's already set (`next` equals `previous`) writes and logs nothing.
 */
export async function changeSetting<T>(
  c: Context<AppEnv>,
  workspaceId: string,
  change: { previous: T; next: T; write: () => Promise<unknown>; event: SettingsChange },
) {
  if (JSON.stringify(change.previous) === JSON.stringify(change.next)) return;
  const [, { userId, ...via }] = await Promise.all([change.write(), changeActor(c)]);
  // recordEvent checks the data against the type's schema.
  await recordEvent(c.var.db, {
    workspaceId,
    actorUserId: userId,
    type: change.event.type,
    data: { ...change.event.data, ...via },
  } as NewActivityEvent);
}
