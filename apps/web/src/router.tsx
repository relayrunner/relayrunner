import { createRouter } from "@tanstack/react-router";
import { RouteError } from "./components/error-boundary";
import { routeTree } from "./routeTree.gen";

// A `getRouter` factory is the shape TanStack Start expects in src/router.tsx,
// so moving from this SPA to Start later keeps this file as-is.
export function getRouter() {
  return createRouter({
    routeTree,
    defaultPreload: "intent",
    scrollRestoration: true,
    // Every route gets its own error boundary, so one page failing leaves the rest of the app up.
    defaultErrorComponent: RouteError,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
