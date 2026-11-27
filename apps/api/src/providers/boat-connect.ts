// Evaluate's Boat Connect step (apps/web features/evaluations/setup.tsx): saving the grant "Sign
// in with boat" returns (src/providers/boat-oauth.ts), and reading back whether Boat can run the
// workspace's jobs yet. Boat runs `runs-on: boat` jobs only on the $20 plan or higher, and only for
// GitHub accounts its CI GitHub App is installed on, neither of which we can do for the person; the
// step shows what's missing, links to where to fix it, and moves on once Boat says it's done.
import { defaultBillingOptions } from "@relayrunner/providers";
import { type Db, schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import { errorMessage } from "../errors.ts";
import { log } from "../log.ts";
import {
  boatAccountName,
  boatCiInstalls,
  boatPlan,
  type BoatCiRepository,
  type BoatPlan,
} from "../provider-billing/boat.ts";
import { ProviderAuthError } from "../provider-billing/types.ts";
import { type BoatGrant, boatOAuthConfigured, connectionBearer } from "./boat-oauth.ts";
import { workspaceLogin } from "./provider-connections.ts";
import { byConnection, NO_FAILURE } from "./provider-sync.ts";
import { sealToken } from "./provider-tokens.ts";

/** Save a fresh grant as the workspace's Boat connection, replacing a key or an older grant. */
export async function saveBoatGrant(
  env: Env,
  db: Db,
  { workspaceId, userId, grant }: { workspaceId: string; userId: string; grant: BoatGrant },
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const accountName = await boatAccountName({
    token: grant.access,
    options: {},
    fetch: fetcher,
  }).catch((error: unknown) => {
    log.warn("provider.boat_me_unreadable", "boat /me unreadable", { workspaceId, error });
    return null;
  });
  const values = {
    token: await sealToken(env, workspaceId, "boat", JSON.stringify(grant)),
    // Shown where a pasted key shows its last characters.
    tokenHint: "Boat sign-in",
    options: defaultBillingOptions("boat"),
    accountName,
    connectedBy: userId,
    syncedThrough: null,
    lastSyncedAt: null,
    ...NO_FAILURE,
  };
  await db
    .insert(schema.providerConnection)
    .values({ workspaceId, provider: "boat", ...values })
    .onConflictDoUpdate({
      target: [schema.providerConnection.workspaceId, schema.providerConnection.provider],
      set: values,
    });
}

export interface BoatReadiness {
  /** Whether "Connect Boat" can go through Boat's sign-in here (the OAuth app is configured). */
  signIn: boolean;
  connected: boolean;
  /** Boat refused the saved connection: connect again. */
  rejected: boolean;
  /** The Boat account, as Boat names it. */
  accountName: string | null;
  /** The GitHub account the workspace is installed on, which Boat's app must be on too. */
  githubAccount: string | null;
  /** The plan of the wallet the workspace's CI jobs bill. Null until connected and read. */
  plan: BoatPlan | null;
  /** Boat's CI app on githubAccount: null when it isn't installed there (or unread). */
  install: { manageUrl: string | null; repositories: BoatCiRepository[] } | null;
  /** Boat couldn't be read just now; the rest is what's known. */
  unreachable: boolean;
  /** Connected, on a plan that runs CI, with the app on the workspace's account. */
  ready: boolean;
}

/** Where the workspace's Boat setup stands, read live from Boat. Never throws for Boat's answer. */
export async function boatReadiness(
  env: Env,
  db: Db,
  workspaceId: string,
  fetcher: typeof fetch = fetch,
  now = new Date(),
): Promise<BoatReadiness> {
  const key = byConnection(schema.providerConnection, workspaceId, "boat");
  const [[connection], githubAccount] = await Promise.all([
    db
      .select({
        token: schema.providerConnection.token,
        failure: schema.providerConnection.failure,
        accountName: schema.providerConnection.accountName,
      })
      .from(schema.providerConnection)
      .where(key)
      .limit(1),
    workspaceLogin(db, workspaceId),
  ]);
  const base: BoatReadiness = {
    signIn: boatOAuthConfigured(env),
    connected: !!connection,
    rejected: connection?.failure === "token_rejected",
    accountName: connection?.accountName ?? null,
    githubAccount,
    plan: null,
    install: null,
    unreachable: false,
    ready: false,
  };
  if (!connection || base.rejected) return base;
  try {
    const token = await connectionBearer(env, db, workspaceId, "boat", connection.token, fetcher);
    const ctx = { token, options: {}, fetch: fetcher };
    const installs = githubAccount ? await boatCiInstalls(ctx, githubAccount) : [];
    const install = installs[0] ?? null;
    // Jobs bill the wallet the install was linked to: an organization's, or the personal one.
    const plan = await boatPlan(ctx, install ? (install.teamId ?? "personal") : null);
    return {
      ...base,
      plan,
      install: install && { manageUrl: install.manageUrl, repositories: install.repositories },
      ready: plan.runsCi && !!install,
    };
  } catch (error) {
    log.warn("provider.boat_readiness_unreadable", "boat readiness unreadable", {
      workspaceId,
      error,
    });
    if (error instanceof ProviderAuthError) {
      await db
        .update(schema.providerConnection)
        .set({ failure: "token_rejected", error: errorMessage(error).slice(0, 500), failedAt: now })
        .where(key);
      return { ...base, rejected: true };
    }
    return { ...base, unreachable: true };
  }
}
