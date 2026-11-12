import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A form control with its label above and an optional hint below, as the admin forms use. */
export function Field({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={cn("grid gap-1 text-sm", className)}>
      {label}
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}
