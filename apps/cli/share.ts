// Who can run jobs on this machine (#244): `relayrunner share`, `connect --share` and the connect
// prompt. The CLI says `only-me` and `anyone`; the gateway stores `only_me` and `anyone`. Changing
// it is PUT /api/machines/me/sharing with the machine token, logged as the machine's owner.

import { z } from "zod";
import { userAgent } from "./paths.ts";

export const SHARE_CHOICES = ["only-me", "anyone"] as const;
export type ShareChoice = (typeof SHARE_CHOICES)[number];

const MachineSharing = z.enum(["only_me", "anyone"]);
export type MachineSharing = z.infer<typeof MachineSharing>;

export function parseShareChoice(value: string): ShareChoice | null {
  return (SHARE_CHOICES as readonly string[]).includes(value) ? (value as ShareChoice) : null;
}

export const toSharing = (choice: ShareChoice): MachineSharing =>
  choice === "only-me" ? "only_me" : "anyone";

export const toChoice = (sharing: MachineSharing): ShareChoice =>
  sharing === "only_me" ? "only-me" : "anyone";

// What a setting means, as in "<machine> runs only jobs you started".
export function sharingMeaning(sharing: MachineSharing, workspace?: string) {
  return sharing === "only_me"
    ? "runs only jobs you started"
    : `runs any job in ${workspace ?? "the workspace"}, including teammates' and bots'`;
}

// The setting and what it means, for `whoami` and `connect`: "only-me: runs only jobs you started".
export function describeSharing(sharing: MachineSharing, workspace?: string) {
  return `${toChoice(sharing)}: ${sharingMeaning(sharing, workspace)}`;
}

const SharingResponse = z.object({ machine: z.object({ sharing: MachineSharing }) });

export type SharingResult =
  | { status: "ok"; sharing: MachineSharing }
  // The token is unknown or the machine was removed from the workspace.
  | { status: "revoked" }
  | { status: "failed"; reason: string };

export async function setSharing(options: {
  server: string;
  token: string;
  sharing: MachineSharing;
  fetcher?: typeof fetch;
}): Promise<SharingResult> {
  const fetcher = options.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(new URL("/api/machines/me/sharing", options.server), {
      method: "PUT",
      headers: {
        authorization: `Bearer ${options.token}`,
        "content-type": "application/json",
        "user-agent": userAgent,
      },
      body: JSON.stringify({ sharing: options.sharing }),
    });
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause?.message;
    return {
      status: "failed",
      reason: `couldn't reach ${options.server}${cause ? ` (${cause})` : ""}`,
    };
  }
  if (response.status === 401) return { status: "revoked" };
  // A gateway from before #244 has no such route.
  if (response.status === 404 || response.status === 405)
    return { status: "failed", reason: `${options.server} doesn't support sharing yet` };
  if (!response.ok)
    return { status: "failed", reason: `${options.server} answered HTTP ${response.status}` };
  const parsed = SharingResponse.safeParse(await response.json().catch(() => null));
  if (!parsed.success)
    return { status: "failed", reason: `${options.server} sent an unexpected response` };
  return { status: "ok", sharing: parsed.data.machine.sharing };
}
