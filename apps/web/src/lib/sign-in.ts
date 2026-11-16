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
    // An agent's sign-in request that RelayRunner can't accept (agent-auth.ts): trying again from
    // here won't help, the agent has to start over.
    case "invalid_client":
    case "invalid_redirect":
    case "unauthorized_client":
    case "unsupported_response_type":
    case "client_disabled":
      return "This agent's sign-in request isn't valid. Start connecting again from the agent.";
    default:
      // invalid_code, state_mismatch, please_restart_the_process and the rest: the hand-off from
      // GitHub didn't complete. Starting over fixes it.
      return "Sign-in didn't finish. Please try again.";
  }
}

// GitHub sometimes refuses the code exchange for a moment (HTTP 429 from its token endpoint, which
// Better Auth reports as invalid_code), and a fresh sign-in seconds later goes through. So the
// sign-in page tries once more on its own, then leaves it to the person.
const RETRY_KEY = "rr_sign_in_retry";
const RETRY_WINDOW_MS = 2 * 60 * 1000;
export const AUTO_RETRY_DELAY_MS = 3000;

/** Whether this failed sign-in should start over on its own: at most once per two minutes. */
export function canAutoRetry(code: string | undefined): boolean {
  if (code !== "invalid_code") return false;
  try {
    const last = Number(sessionStorage.getItem(RETRY_KEY));
    return !last || Date.now() - last >= RETRY_WINDOW_MS;
  } catch {
    return false;
  }
}

/** Records an automatic retry, so the next failure in the window shows the error instead. */
export function markAutoRetry() {
  try {
    sessionStorage.setItem(RETRY_KEY, String(Date.now()));
  } catch {
    // No storage: canAutoRetry already said no.
  }
}
