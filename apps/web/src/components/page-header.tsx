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
        {action}
      </div>
      {children && <p className="mt-2 max-w-[62ch] text-muted-foreground">{children}</p>}
    </header>
  );
}
