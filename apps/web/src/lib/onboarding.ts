// The /device onboarding's choice of whether to send the browser straight to GitHub's App install
// screen (#221), kept apart from the page so it can be tested.

import { canManage } from "./roles.ts";

export type InstallRedirectInput = {
  /** The active workspace's role and installations; null with no workspace yet. */
  current: { role: string; installations: unknown[] } | null;
  /** ?github=<outcome>: GitHub already sent the user back here once. */
  outcome: string | undefined;
  /** ?install=opened: this page already sent the user to GitHub once. */
  opened: boolean;
};

/**
 * True when the only thing left before approving is installing the App, so the GitHub step would
 * be a click with nothing to decide: the user has no workspace yet (installing makes one, #316),
 * or their workspace has no installation. Otherwise the GitHub step shows, for one of these
 * reasons:
 * - GitHub already reported back (?github=), such as a request to an org's owners or an error;
 * - this page already redirected once, so coming back without an install (the user cancelled or
 *   went back) lands on the step instead of in a loop;
 * - the user can't install for this workspace (a member, not an owner or admin).
 */
export function shouldOpenInstall({ current, outcome, opened }: InstallRedirectInput) {
  if (current && current.installations.length > 0) return false;
  if (current && !canManage(current.role)) return false;
  return !outcome && !opened;
}
