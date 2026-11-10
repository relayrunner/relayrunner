import type { ReactNode } from "react";

export function PageHeader({
  title,
  action,
  children,
}: {
  title: string;
  /** Rendered at the end of the title row, e.g. the page's primary button. */
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="mb-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[21px] leading-tight font-bold tracking-[-0.01em]">{title}</h1>
        {/* Pulled in so a button taller than the title doesn't push it down, keeping every
            page's title and subtitle at the same height. */}
        {action && <div className="-my-1.5">{action}</div>}
      </div>
      {children && <p className="mt-2 max-w-[62ch] text-muted-foreground">{children}</p>}
    </header>
  );
}
