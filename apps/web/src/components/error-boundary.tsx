import { CatchBoundary, Link, useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { RotateCwIcon, TriangleAlert } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AppError } from "@relayrunner/errors";

// After a deploy, an open tab can ask for a page's code by a file name that no longer exists.
const isStaleBuild = (error: unknown) =>
  error instanceof Error &&
  /dynamically imported module|Importing a module script failed|error loading dynamically/i.test(
    error.message,
  );

function describe(error: unknown): string {
  if (isStaleBuild(error)) return "RelayRunner was updated. Reload to get the latest version.";
  if (error instanceof AppError) {
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
  const signedOut = error instanceof AppError && error.status === 401;

  async function retry() {
    if (isStaleBuild(error)) return window.location.reload();
    setRetrying(true);
    // Re-run the loaders, then clear the error so the page renders again.
    await router.invalidate().catch(() => undefined);
    setRetrying(false);
    reset();
  }

  return (
    <PageMessage
      alert
      icon={<TriangleAlert aria-hidden className="size-6 text-muted-foreground" />}
      title="Something went wrong"
      body={describe(error)}
    >
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
    </PageMessage>
  );
}

/** A whole-page message in place of a page: a title, a line and what to do next. */
function PageMessage({
  alert = false,
  icon,
  title,
  body,
  className,
  children,
}: {
  alert?: boolean;
  icon?: ReactNode;
  title: string;
  body: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      role={alert ? "alert" : undefined}
      className={cn("grid min-h-[60vh] place-content-center p-4 text-center", className)}
    >
      <div className="grid max-w-md justify-items-center gap-3">
        {icon}
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="text-muted-foreground">{body}</p>
        <div className="mt-1 flex gap-2">{children}</div>
      </div>
    </div>
  );
}

/**
 * A page that doesn't exist. A workspace page that throws `notFound()`, such as an unknown
 * provider, sets this as its own `notFoundComponent` so it shows inside the app, with the sidebar.
 */
export function PageNotFound({ className }: { className?: string }) {
  return (
    <PageMessage title="Not found" body="That page doesn't exist." className={className}>
      <Button asChild variant="outline">
        <Link to="/runners">Go to Runners</Link>
      </Button>
    </PageMessage>
  );
}

/**
 * Keeps a crash in one part of a page to that part. The rest of the page stays usable and the
 * part can be retried in place. Going to another page, or changing this one's range or filters,
 * tries it again too.
 */
export function SectionBoundary({
  children,
  className,
}: {
  children: ReactNode;
  /** For the note that shows in the part's place, such as room for a panel's close button. */
  className?: string;
}) {
  // Read when the part re-renders, which a change to the page's search does, rather than
  // subscribing every boundary on the page to the router.
  const router = useRouter();
  const fallback = useCallback(
    (props: ErrorComponentProps) => <SectionError {...props} className={className} />,
    [className],
  );
  return (
    <CatchBoundary getResetKey={() => router.state.location.href} errorComponent={fallback}>
      {children}
    </CatchBoundary>
  );
}

function SectionError({ error, reset, className }: ErrorComponentProps & { className?: string }) {
  // A part whose code is gone after a deploy fails the same way on every retry, so it reloads.
  const stale = isStaleBuild(error);
  return (
    <div
      role="alert"
      className={cn(
        "flex items-center gap-2 rounded-md border border-dashed p-3 text-sm text-muted-foreground",
        className,
      )}
    >
      <TriangleAlert aria-hidden className="size-4 shrink-0" />
      <span>{stale ? describe(error) : "Couldn't show this part."}</span>
      <Button
        variant="ghost"
        size="xs"
        className="ml-auto"
        onClick={stale ? () => window.location.reload() : reset}
      >
        {stale ? "Reload" : "Try again"}
      </Button>
    </div>
  );
}
