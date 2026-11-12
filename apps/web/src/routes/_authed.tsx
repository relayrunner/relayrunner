import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";
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
    return { user: session.user, session };
  },
  component: Outlet,
});
