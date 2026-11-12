import { createFileRoute, redirect } from "@tanstack/react-router";

// Job times moved to Performance's Jobs tab. Kept so old links and bookmarks still land.
export const Route = createFileRoute("/_authed/_workspace/job-times")({
  beforeLoad: () => {
    throw redirect({ to: "/performance", search: { view: "jobs" }, replace: true });
  },
});
