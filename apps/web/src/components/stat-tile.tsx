import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";

/** A headline number on a card, with what it counts and an optional line under it. */
export function StatTile({
  label,
  value,
  detail,
}: {
  label: string;
  value: ReactNode;
  detail?: string;
}) {
  return (
    <Card className="gap-0 px-4 py-3">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{value}</div>
      {detail && <div className="mt-0.5 text-sm text-muted-foreground">{detail}</div>}
    </Card>
  );
}
