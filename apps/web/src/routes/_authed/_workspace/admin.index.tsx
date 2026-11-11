import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authed/_workspace/admin/")({
  beforeLoad: () => {
    throw redirect({ to: "/admin/users" });
  },
});
