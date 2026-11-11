// `relayrunner pause` and `resume`: ask the gateway to stop or start routing jobs to this machine
// (POST /api/machines/me/pause|resume with the machine token). The machine stays connected either
// way; a running `relayrunner connect` hears about it and says so.

import { z } from "zod";
import { withCurrentToken, type Credentials } from "./credentials.ts";
import { userAgent } from "./paths.ts";

const PauseResponse = z.object({
  machine: z.object({
    name: z.string(),
    paused: z.object({ by: z.string().nullable() }).nullable(),
    status: z.object({ state: z.string().nullable() }).optional(),
  }),
});

export type PauseResult =
  // `busy`: the machine is running a job, which it finishes first.
  | { status: "ok"; paused: boolean; busy: boolean }
  // The token is unknown or the machine was removed from the workspace.
  | { status: "revoked" }
  | { status: "failed"; reason: string };

export async function setPaused(options: {
  server: string;
  token: string;
  paused: boolean;
  fetcher?: typeof fetch;
}): Promise<PauseResult> {
  const fetcher = options.fetcher ?? fetch;
  const action = options.paused ? "pause" : "resume";
  let response: Response;
  try {
    response = await fetcher(new URL(`/api/machines/me/${action}`, options.server), {
      method: "POST",
      headers: { authorization: `Bearer ${options.token}`, "user-agent": userAgent },
    });
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause?.message;
    return {
      status: "failed",
      reason: `couldn't reach ${options.server}${cause ? ` (${cause})` : ""}`,
    };
  }
  if (response.status === 401) return { status: "revoked" };
  if (!response.ok)
    return { status: "failed", reason: `${options.server} answered HTTP ${response.status}` };
  const parsed = PauseResponse.safeParse(await response.json().catch(() => null));
  if (!parsed.success)
    return { status: "failed", reason: `${options.server} sent an unexpected response` };
  return {
    status: "ok",
    paused: parsed.data.machine.paused !== null,
    busy: parsed.data.machine.status?.state === "busy",
  };
}

/** setPaused with the machine's saved token, retrying with a newer one if it was rotated. */
export function pauseMachine(credentials: Credentials, paused: boolean) {
  return withCurrentToken(credentials, (token) =>
    setPaused({ server: credentials.server, token, paused }),
  );
}
