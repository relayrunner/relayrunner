import { createRouter } from "@tanstack/react-router";
import { RouteError } from "./components/error-boundary";
import { PagePending } from "./components/page-pending";
import { forgetSession, setOnSessionChange } from "./lib/session";
import { routeTree } from "./routeTree.gen";

// A `getRouter` factory is the shape TanStack Start expects in src/router.tsx,
// so moving from this SPA to Start later keeps this file as-is.
export function getRouter() {
  const router = createRouter({
    routeTree,
    defaultPreload: "intent",
    scrollRestoration: true,
    // Every route gets its own error boundary, so one page failing leaves the rest of the app up.
    defaultErrorComponent: RouteError,
    // A page whose data isn't back yet shows a skeleton instead of leaving the last page up, so a
    // click answers at once. Data that comes back quickly (a hover preloaded it) skips the
    // skeleton, and one that shows stays long enough not to flicker.
    defaultPendingComponent: PagePending,
    defaultPendingMs: 80,
    defaultPendingMinMs: 150,
  });

  // The guards keep the session and workspace (lib/session.ts). Invalidating after a change,
  // such as switching workspace or changing a role, reads them fresh too.
  const invalidate = router.invalidate.bind(router);
  router.invalidate = (opts) => {
    forgetSession();
    return invalidate(opts);
  };
  // A background check found the session or workspace changed: re-run the guards with the new
  // copy, which redirect if they need to.
  setOnSessionChange(() => void invalidate());

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
