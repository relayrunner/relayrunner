import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

export function PageHeader({
  title,
  action,
  children,
  wide = false,
}: {
  title: string;
  /** Rendered at the end of the title row, e.g. the page's primary button. */
  action?: ReactNode;
  children?: ReactNode;
  /** Let the line under the title run the full width, for a one-line status rather than prose. */
  wide?: boolean;
}) {
  return (
    <header className="mb-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[21px] leading-tight font-bold tracking-[-0.01em]">{title}</h1>
        {action}
      </div>
      {children && (
        <p className={cn("mt-2 text-muted-foreground", !wide && "max-w-[62ch]")}>{children}</p>
      )}
    </header>
  );
}
