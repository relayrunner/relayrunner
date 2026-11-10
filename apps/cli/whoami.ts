// `relayrunner whoami`: asks the gateway who the saved machine token belongs to
// (GET /api/machines/me). Only reads: a revoked token is reported, not deleted, since the next
// `connect` replaces it.

import { z } from "zod";
import { userAgent } from "./paths.ts";

export const WhoamiResponse = z.object({
  machine: z.object({
    id: z.string().min(1),
    name: z.string(),
    os: z.string().nullable(),
    arch: z.string().nullable(),
    createdAt: z.union([z.string(), z.number()]),
    lastSeenAt: z.union([z.string(), z.number()]).nullable(),
    status: z.object({ online: z.boolean(), state: z.string().nullable() }),
    // Missing from a gateway that predates pausing.
    paused: z.object({ by: z.string().nullable() }).nullish(),
    // Missing from a gateway that predates sharing (#242).
    sharing: z.enum(["only_me", "anyone"]).optional(),
  }),
  workspace: z.object({
    id: z.string().min(1),
    name: z.string(),
    slug: z.string().nullish(),
    memberCount: z.number().int().nonnegative().optional(),
  }),
  enrolledBy: z.object({ name: z.string(), email: z.string() }).nullable(),
});
export type WhoamiResponse = z.infer<typeof WhoamiResponse>;

export type WhoamiResult =
  | { status: "ok"; identity: WhoamiResponse }
  // The token is unknown or the machine was removed from the workspace.
  | { status: "revoked" }
  // The gateway couldn't be reached or answered with something unexpected.
  | { status: "unverified"; reason: string };

export async function whoami(options: {
  server: string;
  token: string;
  fetcher?: typeof fetch;
}): Promise<WhoamiResult> {
  const fetcher = options.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(new URL("/api/machines/me", options.server), {
      headers: { authorization: `Bearer ${options.token}`, "user-agent": userAgent },
    });
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause?.message;
    return {
      status: "unverified",
      reason: `Couldn't reach ${options.server}${cause ? ` (${cause})` : ""}`,
    };
  }
  if (response.status === 401) return { status: "revoked" };
  if (!response.ok)
    return { status: "unverified", reason: `${options.server} answered HTTP ${response.status}` };
  const parsed = WhoamiResponse.safeParse(await response.json().catch(() => null));
  if (!parsed.success)
    return { status: "unverified", reason: `${options.server} sent an unexpected response` };
  return { status: "ok", identity: parsed.data };
}
