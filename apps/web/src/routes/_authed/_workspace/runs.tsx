import { createFileRoute, redirect } from "@tanstack/react-router";

// Runs moved to History's Workflows tab. Kept so old links and bookmarks still land.
export const Route = createFileRoute("/_authed/_workspace/runs")({
  beforeLoad: () => {
    throw redirect({ to: "/history", replace: true });
  },
});
