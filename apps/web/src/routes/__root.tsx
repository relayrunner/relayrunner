import { Outlet, createRootRoute } from "@tanstack/react-router";
import { PageNotFound } from "@/components/error-boundary";

export const Route = createRootRoute({
  component: () => <Outlet />,
  // Outside the app's layout, such as a path no page has, it fills the window.
  notFoundComponent: () => <PageNotFound className="min-h-screen" />,
});
