// The /device onboarding's decisions (#221, #322), kept apart from the page so they can be tested.
// A workspace is one GitHub App installation (#316) and a machine belongs to its user, not to a
// workspace (#318), so the only question is whether the user has any workspace yet.

export type OnboardingInput = {
  /** The user is in at least one workspace, so the App is installed somewhere they can see. */
  hasWorkspace: boolean;
  /** ?github=<outcome>: GitHub already sent the user back here once. */
  outcome: string | undefined;
};

/**
 * True when the user has no workspace yet, so installing the App (which makes one) is the only
 * thing left before approving, and the GitHub step would be a click with nothing to decide. The
 * GitHub step shows instead when GitHub already reported back (?github=), such as an error, or
 * when this page already redirected once (?install=opened), so coming back without an install
 * (cancelling, or the back button) doesn't loop.
 */
export function shouldOpenInstall({
  hasWorkspace,
  outcome,
  opened,
}: OnboardingInput & { opened: boolean }) {
  return !hasWorkspace && !outcome && !opened;
}

/**
 * The step to show. Approving needs no workspace, since the machine is the user's: someone whose
 * install only sent a request to an org's owners (?github=requested) approves now, and jobs reach
 * the machine once an owner accepts.
 */
export function onboardingStep({ hasWorkspace, outcome }: OnboardingInput): "github" | "approve" {
  return hasWorkspace || outcome === "requested" ? "approve" : "github";
}
