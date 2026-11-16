// A GitHub sign-in that fails on the way back lands on /login?error=<code> (apps/api/src/auth.ts
// onAPIError). These helpers turn that code into words and keep the page's own query (redirect,
// an agent's signed request) so trying again picks up where the first try left off.

const ERROR_PARAMS = ["error", "error_description"];

/** Where a failed sign-in started from this page should come back to: here, minus the error. */
export function signInErrorURL() {
  const params = new URLSearchParams(window.location.search);
  for (const name of ERROR_PARAMS) params.delete(name);
  const query = params.toString();
  return `/login${query ? `?${query}` : ""}`;
}

/** Plain words for a sign-in error code, or null when there's no error. */
export function describeSignInError(code: string | undefined): string | null {
  if (!code) return null;
  switch (code) {
    case "access_denied":
      return "Sign-in was cancelled on GitHub.";
    case "email_not_found":
    case "unable_to_get_user_info":
      return "GitHub didn't share your account details. Try again, or check the RelayRunner app's access in your GitHub settings.";
    default:
      // invalid_code, state_mismatch, please_restart_the_process and the rest: the hand-off from
      // GitHub didn't complete. Starting over fixes it.
      return "Sign-in didn't finish. Please try again.";
  }
}
