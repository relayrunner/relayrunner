// Boat's job-start limits, for the Router's Boat step (#672). Boat's plans cap how many jobs start
// per minute, hour and day, and a job past a window's cap sits "Paused by plan limit" until
// someone re-runs it, so the step passes the job on instead once a window has no starts left.
//
// Only the hour and day windows pass a job on. At a full minute window Boat's GitHub App waits and
// retries every 15 seconds, so the job starts within the minute anyway (docs.boat.dev/limits);
// at a full hour or day window it pauses the job instead.
//
// The count comes from Boat's own `GET /api/v1/limits`, read with the workspace's Boat connection
// (Settings › Providers). Without one, with a key Boat refuses, or when the read fails, the step
// takes the job as it always has: a missing number shouldn't stall CI.
import type { StartLimit, StartWindow } from "@relayrunner/activity";
import { and, eq } from "drizzle-orm";
import { type Db, schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import { errorMessage } from "../errors.ts";
import { boatLimits, type StartsLeft } from "../provider-billing/boat.ts";
import { ProviderAuthError } from "../provider-billing/index.ts";
import { openToken } from "./provider-tokens.ts";

// The windows whose full cap pauses a job, shortest first.
export const PAUSING_WINDOWS: readonly StartWindow[] = ["hour", "day"];

/** The workspace's Boat starts left, or null when there's no connection to ask or the read fails. */
export async function readBoatStarts(
  env: Pick<Env, "PROVIDER_TOKEN_KEY">,
  db: Db,
  workspaceId: string,
  fetcher: typeof fetch = fetch,
  now = new Date(),
): Promise<StartsLeft | null> {
  const connections = schema.providerConnection;
  const key = and(eq(connections.workspaceId, workspaceId), eq(connections.provider, "boat"));
  const [connection] = await db
    .select({ token: connections.token, failure: connections.failure })
    .from(connections)
    .where(key)
    .limit(1);
  // A refused key stays refused until someone pastes a new one, which clears the failure.
  if (!connection || connection.failure === "token_rejected") return null;
  try {
    const token = await openToken(env, workspaceId, "boat", connection.token);
    return await boatLimits({ token, options: {}, fetch: fetcher });
  } catch (error) {
    console.warn(
      JSON.stringify({ msg: "boat limits unreadable", workspaceId, error: errorMessage(error) }),
    );
    if (error instanceof ProviderAuthError)
      // Settings › Providers then says the key stopped working.
      await db
        .update(connections)
        .set({
          failure: "token_rejected",
          error: errorMessage(error).slice(0, 500),
          failedAt: now,
        })
        .where(key);
    return null;
  }
}

/**
 * The first window with no starts left once `taken` more jobs have gone to Boat since the reading,
 * or null when every window has room (or Boat didn't say).
 */
export function ranOutOfStarts(starts: StartsLeft | null, taken = 0): StartLimit | null {
  if (!starts) return null;
  for (const window of PAUSING_WINDOWS) {
    const left = starts[window];
    if (left && left.remaining - taken <= 0) return { window, limit: left.limit };
  }
  return null;
}

// How long a reading is reused. Short, since the windows roll; the jobs the Router sends to Boat
// meanwhile are counted against it (StartBudget.took).
export const STARTS_TTL_MS = 10_000;

/**
 * One workspace's Boat reading, reused for STARTS_TTL_MS, with the jobs sent to Boat since it was
 * read, so a burst of jobs inside one reading can't use more starts than it had left.
 */
export class StartBudget {
  private reading: { at: number; starts: Promise<StartsLeft | null>; taken: number } | undefined;

  constructor(private ttl = STARTS_TTL_MS) {}

  async check(read: () => Promise<StartsLeft | null>, now = Date.now()) {
    if (!this.reading || now - this.reading.at >= this.ttl) {
      const reading = { at: now, starts: read().catch(() => null), taken: 0 };
      this.reading = reading;
    }
    const reading = this.reading;
    return ranOutOfStarts(await reading.starts, reading.taken);
  }

  /** A job went to Boat: one fewer start in the current reading. */
  took() {
    if (this.reading) this.reading.taken++;
  }
}
