import { CatchBoundary, Link, useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { RotateCwIcon, TriangleAlert } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";

// After a deploy, an open tab can ask for a page's code by a file name that no longer exists.
const isStaleBuild = (error: unknown) =>
  error instanceof Error &&
  /dynamically imported module|Importing a module script failed|error loading dynamically/i.test(
    error.message,
  );

function describe(error: unknown): string {
  if (isStaleBuild(error)) return "RelayRunner was updated. Reload to get the latest version.";
  if (error instanceof ApiError) {
    if (error.status === 401) return "Your session ended. Sign in again to keep going.";
    if (error.status === 403) return "You don't have access to this.";
    if (error.status === 404) return "We couldn't find that.";
    return "RelayRunner couldn't load this right now.";
  }
  if (error instanceof TypeError && /fetch|network/i.test(error.message))
    return "Couldn't reach RelayRunner. Check your connection.";
  return "Something broke while showing this page.";
}

/**
 * The router's default error view: a failed loader or a crash in a page shows here, in place of
 * that page, so the sidebar and every other page keep working.
 */
export function RouteError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const [retrying, setRetrying] = useState(false);
  const signedOut = error instanceof ApiError && error.status === 401;

  async function retry() {
    if (isStaleBuild(error)) return window.location.reload();
    setRetrying(true);
    // Re-run the loaders, then clear the error so the page renders again.
    await router.invalidate().catch(() => undefined);
    setRetrying(false);
    reset();
  }

  return (
    <div role="alert" className="grid min-h-[60vh] place-content-center p-4 text-center">
      <div className="grid max-w-md justify-items-center gap-3">
        <TriangleAlert aria-hidden className="size-6 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Something went wrong</h1>
        <p className="text-muted-foreground">{describe(error)}</p>
        <div className="mt-1 flex gap-2">
          {signedOut ? (
            <Button asChild>
              <Link to="/login" search={{ redirect: window.location.href }}>
                Sign in
              </Link>
            </Button>
          ) : (
            <Button onClick={retry} disabled={retrying}>
              <RotateCwIcon aria-hidden className={retrying ? "animate-spin" : undefined} />
              {isStaleBuild(error) ? "Reload" : "Try again"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Keeps a crash in one part of a page to that part. The rest of the page stays usable and the
 * part can be retried in place.
 */
export function SectionBoundary({ children }: { children: ReactNode }) {
  return (
    <CatchBoundary getResetKey={() => 0} errorComponent={SectionError}>
      {children}
    </CatchBoundary>
  );
}

function SectionError({ reset }: ErrorComponentProps) {
  return (
    <div
      role="alert"
      className="flex items-center gap-2 rounded-md border border-dashed p-3 text-sm text-muted-foreground"
    >
      <TriangleAlert aria-hidden className="size-4 shrink-0" />
      <span>Couldn't load this part.</span>
      <Button variant="ghost" size="xs" className="ml-auto" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
