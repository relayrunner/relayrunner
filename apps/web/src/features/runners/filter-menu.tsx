// The self-hosted runners' filter menu on the Runners page.
import { ListFilterIcon } from "lucide-react";
import { type ReactNode } from "react";
import { sharingLabel } from "@/components/machine-sharing";
import { type RunnerRow } from "@/components/runner-list";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  CLEARED_FILTERS,
  joinFilter,
  type RunnerSearch,
  splitFilter,
  STATUSES,
} from "@/lib/runner-filters";
import { cn } from "@/lib/utils";

// Narrows the self-hosted runners by status, owner and whose jobs they take. Each section lists
// only what the runners have, plus anything already picked.
export function RunnerFilterMenu({
  rows,
  search,
  count,
  inactiveCount,
  onChange,
}: {
  rows: RunnerRow[];
  search: RunnerSearch;
  count: number;
  inactiveCount: number;
  onChange: (next: Partial<RunnerSearch>) => void;
}) {
  const statuses = splitFilter(search.status);
  const owners = splitFilter(search.owner);
  const tones = new Set<string>([...rows.map((row) => row.view.tone), ...statuses]);
  const ownerOptions = [...new Set([...rows.map((row) => row.owner), ...owners])].sort(
    (a, b) => Number(b === "You") - Number(a === "You") || a.localeCompare(b),
  );
  const toggle = (values: string[], value: string, on: boolean) =>
    joinFilter(on ? [...values, value] : values.filter((v) => v !== value));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="xs" className={cn(count > 0 && "text-foreground")}>
          <ListFilterIcon aria-hidden className={cn(count > 0 && "text-go")} />
          {count > 0 ? `Filtered by ${count}` : "Filter"}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <FilterSection label="Status">
          {STATUSES.filter((status) => tones.has(status.value)).map((status) => (
            <FilterItem
              key={status.value}
              checked={statuses.includes(status.value)}
              onChange={(on) => onChange({ status: toggle(statuses, status.value, on) })}
            >
              {status.label}
            </FilterItem>
          ))}
        </FilterSection>
        {ownerOptions.length > 1 && (
          <FilterSection label="Owner">
            {ownerOptions.map((owner) => (
              <FilterItem
                key={owner}
                checked={owners.includes(owner)}
                onChange={(on) => onChange({ owner: toggle(owners, owner, on) })}
              >
                <span className="truncate">{owner}</span>
              </FilterItem>
            ))}
          </FilterSection>
        )}
        <FilterSection label="Runs">
          {(["anyone", "only_me"] as const).map((value) => (
            <FilterItem
              key={value}
              checked={search.runs === value}
              onChange={(on) => onChange({ runs: on ? value : undefined })}
            >
              {value === "anyone" ? sharingLabel("anyone", false) : "Only its owner's jobs"}
            </FilterItem>
          ))}
        </FilterSection>
        {inactiveCount > 0 && (
          <>
            <DropdownMenuSeparator />
            <FilterItem
              checked={search.inactive ?? false}
              onChange={(on) => onChange({ inactive: on || undefined })}
            >
              Show inactive runners
            </FilterItem>
          </>
        )}
        {count > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onChange(CLEARED_FILTERS)}>
              Clear filters
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// A labeled group of checkboxes, with a separator above all but the first.
function FilterSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      {label !== "Status" && <DropdownMenuSeparator />}
      <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
        {label}
      </DropdownMenuLabel>
      {children}
    </>
  );
}

// A checkbox that leaves the menu open, so several can be picked in a row.
function FilterItem({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
  children: ReactNode;
}) {
  return (
    <DropdownMenuCheckboxItem
      checked={checked}
      onSelect={(event) => event.preventDefault()}
      onCheckedChange={(on) => onChange(on === true)}
    >
      {children}
    </DropdownMenuCheckboxItem>
  );
}
