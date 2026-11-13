import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";
import { identifyUser } from "@/lib/analytics";
import { authDisabled } from "@/lib/auth-client";
import { agreedSession } from "@/lib/legal";

// Pathless layout: every route under routes/_authed/ requires a session.
// It also requires agreeing to the current Terms of Service and Privacy Policy (routes/agree.tsx).
// routes/_authed/_workspace/ additionally requires an active workspace.
export const Route = createFileRoute("/_authed")({
  beforeLoad: async ({ location }) => {
    if (authDisabled) return { user: null, session: null };
    const session = await agreedSession(location.href);
    if (!session) {
      throw redirect({ to: "/login", search: { redirect: location.href } });
    }
    identifyUser(session.user);
    return { user: session.user, session };
  },
  // The first page load shows nothing until the guards are done, rather than a page skeleton
  // without the app around it. Later navigations reuse their answer, so only the page is pending.
  pendingMs: Infinity,
  component: Outlet,
});
