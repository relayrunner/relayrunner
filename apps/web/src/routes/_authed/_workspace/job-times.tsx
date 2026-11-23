import { createFileRoute, redirect } from "@tanstack/react-router";

// Job times moved to Performance, whose workflows open their jobs. Kept so old links still land.
export const Route = createFileRoute("/_authed/_workspace/job-times")({
  beforeLoad: () => {
    throw redirect({ to: "/performance", replace: true });
  },
});
