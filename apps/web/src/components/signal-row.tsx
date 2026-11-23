import type { ReactNode } from "react";

/** One signal on Settings → Telemetry: its name, what it holds, and the choice. */
export function SignalRow({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
      <div className="grid min-w-0 flex-1 basis-64 gap-0.5">
        <span className="font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">{description}</span>
      </div>
      {children}
    </div>
  );
}
