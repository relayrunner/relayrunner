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

// ---- Readiness: what Evaluate's Connect step checks before a run (src/providers/boat-readiness.ts)

/** The plan of the wallet a CI job bills, from /limits. */
export interface BoatPlan {
  /** Boat's plan key, such as box_20, or `trial` before any payment. */
  key: string | null;
  dollars: number | null;
  /** Whether `runs-on: boat` jobs run: the $20 plan or higher (or an unlimited account). */
  runsCi: boolean;
  /** Boat's own reason it can't start anything now, such as a suspended account. */
  blockedReason: string | null;
}

interface RawPlan {
  sandboxPlanKey?: unknown;
  sandboxPlanDollars?: unknown;
  unlimited?: unknown;
  canStart?: unknown;
  startBlockedReason?: unknown;
  blockedReason?: unknown;
}

const text = (value: unknown) => (typeof value === "string" && value ? value : null);

export function parsePlan(body: RawPlan): BoatPlan {
  const key = text(body.sandboxPlanKey);
  const dollars = num(body.sandboxPlanDollars);
  const canStart = body.canStart !== false;
  const paid = body.unlimited === true || (key !== "trial" && (dollars ?? 0) >= 20);
  return {
    key,
    dollars,
    runsCi: paid && canStart,
    blockedReason: canStart ? null : (text(body.startBlockedReason) ?? text(body.blockedReason)),
  };
}

/** The plan of `org`'s wallet (a Boat organization id, or `personal`), else the active one. */
export async function boatPlan(ctx: AdapterContext, org?: string | null): Promise<BoatPlan> {
  const query = org ? `?${new URLSearchParams({ org })}` : "";
  return parsePlan(await requestJson<RawPlan>(ctx, `${BASE}/limits${query}`));
}

export interface BoatCiRepository {
  fullName: string;
  private: boolean;
  /** ok, no-jobs, failing, or public-blocked (a public repo, whose jobs never run on Boat). */
  status: string;
}

/** One install of Boat's CI GitHub App the account can see. */
export interface BoatCiInstall {
  account: string;
  accountType: string;
  /** The Boat organization whose wallet pays; null for the personal wallet. */
  teamId: string | null;
  /** GitHub's page to choose the install's repositories. */
  manageUrl: string | null;
  repositories: BoatCiRepository[];
}

interface RawCi {
  installations?: {
    accountLogin?: unknown;
    accountType?: unknown;
    teamId?: unknown;
    manageUrl?: unknown;
    repositories?: { fullName?: unknown; private?: unknown; status?: unknown }[];
  }[];
}

export function parseCi(body: RawCi): BoatCiInstall[] {
  return (body.installations ?? []).flatMap((install) => {
    const account = text(install.accountLogin);
    if (!account) return [];
    return [
      {
        account,
        accountType: text(install.accountType) ?? "User",
        teamId: text(install.teamId),
        manageUrl: text(install.manageUrl),
        repositories: (install.repositories ?? []).flatMap((repo) => {
          const fullName = text(repo.fullName);
          return fullName
            ? [{ fullName, private: repo.private !== false, status: text(repo.status) ?? "ok" }]
            : [];
        }),
      },
    ];
  });
}

/** Boat's CI installs on one GitHub account (`GET /ci?account=`), with no job list. */
export async function boatCiInstalls(
  ctx: AdapterContext,
  account: string,
): Promise<BoatCiInstall[]> {
  const query = new URLSearchParams({ account, limit: "1" });
  const installs = parseCi(await requestJson<RawCi>(ctx, `${BASE}/ci?${query}`));
  // `account` narrows Boat's answer already; matching again keeps a looser server honest.
  return installs.filter((i) => i.account.toLowerCase() === account.toLowerCase());
}

/** The Boat account's name: its GitHub login when it signed up with GitHub. */
export async function boatAccountName(ctx: AdapterContext): Promise<string | null> {
  const body = await requestJson<{ user?: { login?: unknown; displayName?: unknown } }>(
    ctx,
    `${BASE}/me`,
  );
  return text(body.user?.login) ?? text(body.user?.displayName);
}
