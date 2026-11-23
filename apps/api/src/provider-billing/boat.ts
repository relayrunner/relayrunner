// Boat's REST API with an API key allowed the account.read action.
// `GET https://boat.dev/api/v1/limits` (https://docs.boat.dev/api/reference/account/get-boat-limits)
// says how many starts the plan has left in its rolling minute, hour and day windows, as
// `starts.{minute,hour,day}.{limit,used,remaining}`; each window is null on an unlimited account.
// CI jobs, sandboxes, forks and resumes all count as starts. The connection only reads limits for
// now, so a sync stores no usage rows.
import {
  type AdapterContext,
  type BillingAdapter,
  num,
  ProviderApiError,
  requestJson,
} from "./types.ts";

const BASE = "https://boat.dev/api/v1";

/** Starts left in one window of the plan, and the window's size when Boat says. */
export interface WindowStarts {
  remaining: number;
  limit: number | null;
}

/** Each window's starts left; a window Boat didn't report is null and never blocks. */
export interface StartsLeft {
  minute: WindowStarts | null;
  hour: WindowStarts | null;
  day: WindowStarts | null;
}

type RawWindow = { remaining?: unknown; limit?: unknown } | undefined;

interface RawLimits {
  starts?: { minute?: RawWindow; hour?: RawWindow; day?: RawWindow };
}

function windowStarts(raw: RawWindow): WindowStarts | null {
  const remaining = num(raw?.remaining);
  return remaining === null ? null : { remaining, limit: num(raw?.limit) };
}

/** Boat's /limits answer as starts left per window. */
export function parseLimits(body: RawLimits): StartsLeft {
  const starts = body.starts;
  return {
    minute: windowStarts(starts?.minute),
    hour: windowStarts(starts?.hour),
    day: windowStarts(starts?.day),
  };
}

export async function boatLimits(ctx: AdapterContext): Promise<StartsLeft> {
  return parseLimits(await requestJson<RawLimits>(ctx, `${BASE}/limits`));
}

export const boat: BillingAdapter = {
  async verify(ctx) {
    const body = await requestJson<RawLimits & { ok?: unknown }>(ctx, `${BASE}/limits`);
    if (body.ok !== true) throw new ProviderApiError("Boat's /limits answer wasn't ok");
    return { accountName: null };
  },

  async usage() {
    return { jobs: [], days: [] };
  },
};
