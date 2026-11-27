import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** A whole-page message in place of a page: a title, a line and what to do next. */
export function PageMessage({
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
 * A page that doesn't exist. A workspace page renders it itself, such as for an unknown provider,
 * so the sidebar stays: a thrown `notFound()` replaces the whole app. It lives apart from the error
 * views so a page that uses it keeps its code out of the dashboard's first load.
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
