// The /device onboarding's choice of whether to send the browser straight to GitHub's App install
// screen (#221), kept apart from the page so it can be tested.

import { canManage } from "./roles.ts";

export type InstallRedirectInput = {
  /** The active workspace's role and installations; null with no workspace yet. */
  current: { role: string; installations: unknown[] } | null;
  /** Installations of the App that no workspace has claimed yet, which the user can add. */
  unclaimedCount: number;
  /** ?github=<outcome>: GitHub already sent the user back here once. */
  outcome: string | undefined;
  /** ?install=opened: this page already sent the user to GitHub once. */
  opened: boolean;
};

/**
 * True when the only thing left before approving is installing the App, so the GitHub step would
 * be a click with nothing to decide. Otherwise the GitHub step shows, for one of these reasons:
 * - an unclaimed install is waiting, so the user picks between Add and installing anew;
 * - GitHub already reported back (?github=), such as a request to an org's owners or an error;
 * - this page already redirected once, so coming back without an install (the user cancelled or
 *   went back) lands on the step instead of in a loop;
 * - the user can't install for this workspace (a member, not an owner or admin).
 */
export function shouldOpenInstall({
  current,
  unclaimedCount,
  outcome,
  opened,
}: InstallRedirectInput) {
  if (!current || current.installations.length > 0) return false;
  if (!canManage(current.role)) return false;
  return unclaimedCount === 0 && !outcome && !opened;
}

/** A first workspace's name: the GitHub login, else the profile name, else a plain default. */
export function firstWorkspaceName(
  login: string | null | undefined,
  name: string | null | undefined,
) {
  return login?.trim() || name?.trim() || "My workspace";
}
