// One line of the Signals breakdown.
import { type ReactNode } from "react";
import { Count } from "@/components/count";
import { PublicRepoMark } from "@/components/public-repo";
import { PHONE_HIDDEN, TableCell, TableRow } from "@/components/ui/table";
import { folderName, type BreakdownBy, type BreakdownRow, triggerName } from "@/lib/signals";
import { money } from "@/lib/usage";
import { cn } from "@/lib/utils";
import { SubjectText } from "@/features/signals/signal-card";

// A row with `onSelect` narrows the page to it; its name is the button, the whole row the target.
export function BreakdownLine({
  name,
  sums,
  total,
  onSelect,
}: {
  name: ReactNode;
  sums: { runs: number; minutes: number; cost: number };
  total: number;
  onSelect?: () => void;
}) {
  const share = total ? sums.minutes / total : 0;
  return (
    <TableRow onClick={onSelect} className={cn(onSelect && "cursor-pointer")}>
      <TableCell className="truncate">
        {onSelect ? (
          <button type="button" className="max-w-full truncate text-left hover:underline">
            {name}
          </button>
        ) : (
          name
        )}
      </TableCell>
      <TableCell className={PHONE_HIDDEN}>
        <div className="flex items-center gap-2">
          <div aria-hidden className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised-2">
            <div className="h-full rounded-full bg-primary" style={{ width: `${share * 100}%` }} />
          </div>
          <span className="w-9 text-right text-xs text-muted-foreground tabular-nums">
            {Math.round(share * 100)}%
          </span>
        </div>
      </TableCell>
      <TableCell className={cn("text-right tabular-nums", PHONE_HIDDEN)}>
        <Count value={sums.runs} />
      </TableCell>
      <TableCell className="text-right font-medium tabular-nums">
        <Count value={sums.minutes} />
      </TableCell>
      <TableCell className="text-right tabular-nums">{money(sums.cost)}</TableCell>
    </TableRow>
  );
}

// Workflows and folders show their repo only when the page covers more than one.
export function BreakdownName({
  by,
  row,
  manyRepos,
}: {
  by: BreakdownBy;
  row: BreakdownRow;
  manyRepos: boolean;
}) {
  if (by === "workflow" || by === "path") {
    const name = by === "path" ? folderName(row.name) : row.name;
    return manyRepos && row.repository ? (
      <SubjectText repository={row.repository} name={name} />
    ) : (
      name
    );
  }
  if (by === "trigger") return triggerName(row.name);
  if (by === "repository")
    return (
      <>
        {row.name}
        <PublicRepoMark repository={row.name} />
      </>
    );
  return row.name;
}
