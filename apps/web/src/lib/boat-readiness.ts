import { api } from "@/lib/api";

/** Where the workspace's Boat setup stands, read live from Boat (GET /api/providers/boat/readiness). */
export interface BoatReadiness {
  /** Whether "Connect Boat" goes through Boat's sign-in here. False: connect by installing, as before. */
  signIn: boolean;
  connected: boolean;
  /** Boat refused the saved connection: connect again. */
  rejected: boolean;
  accountName: string | null;
  /** The GitHub account the workspace is installed on, which Boat's app must be on too. */
  githubAccount: string | null;
  plan: {
    key: string | null;
    dollars: number | null;
    runsCi: boolean;
    blockedReason: string | null;
  } | null;
  /** Boat's CI app on githubAccount, or null when it isn't installed there. */
  install: {
    manageUrl: string | null;
    repositories: { fullName: string; private: boolean; status: string }[];
  } | null;
  unreachable: boolean;
  ready: boolean;
}

export const getBoatReadiness = () => api<BoatReadiness>("/providers/boat/readiness");

/** The full-page trip to Boat's sign-in, coming back to `next`. */
export const boatConnectUrl = (next: string) =>
  `/api/providers/boat/connect?${new URLSearchParams({ next })}`;

// Boat's dashboard: its billing tab (plans) and its CI tab (the CI GitHub App).
export const BOAT_BILLING_URL = "https://boat.dev/dashboard?tab=billing";
export const BOAT_CI_URL = "https://boat.dev/dashboard?tab=ci";
