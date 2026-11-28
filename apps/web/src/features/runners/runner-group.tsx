// The Runners page's groups (personal, shared, cloud): their heading, view toggle and footnote.
import { LayoutGridIcon, ListIcon } from "lucide-react";
import { type ReactNode } from "react";
import { SectionBoundary } from "@/components/error-boundary";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { plural } from "@/lib/job-times";
import { INACTIVE_DAYS } from "@/lib/runner-filters";
import { cn } from "@/lib/utils";

// Card-shaped placeholders while a section's first answer is on its way.
export function CardSkeletons({ count }: { count: number }) {
  return Array.from({ length: count }, (_, i) => (
    <li key={i} className="grid min-w-0" aria-hidden>
      <div className="h-44 animate-pulse rounded-xl bg-muted" />
    </li>
  ));
}

export function RunnerGroup({
  title,
  action,
  bare = false,
  footer,
  children,
}: {
  title: string;
  /** A control at the end of the heading. */
  action?: ReactNode;
  /** A line under the group, such as what's hidden. */
  footer?: ReactNode;
  /** Children laid out as they are, not as a grid of cards. */
  bare?: boolean;
  children: ReactNode;
}) {
  const id = `group-${title.toLowerCase().replaceAll(" ", "-")}`;
  return (
    <section aria-labelledby={id} className="grid gap-3">
      <div className="flex min-h-6 items-center justify-between gap-2">
        <h2 id={id} className="flex items-baseline gap-2 text-sm font-semibold">
          {title}
        </h2>
        {action}
      </div>
      <SectionBoundary>
        {bare ? (
          children
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,19rem),1fr))] gap-3">
            {children}
          </ul>
        )}
      </SectionBoundary>
      {footer}
    </section>
  );
}

// Cards or a list, as two icon buttons.
export function ViewToggle({
  list,
  onChange,
}: {
  list: boolean;
  onChange: (list: boolean) => void;
}) {
  const options = [
    { list: false, label: "Cards", icon: <LayoutGridIcon aria-hidden /> },
    { list: true, label: "List", icon: <ListIcon aria-hidden /> },
  ];
  return (
    <div role="group" aria-label="View" className="flex items-center">
      {options.map((option) => (
        <Tooltip key={option.label}>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={option.label}
              aria-pressed={list === option.list}
              className={cn(list === option.list ? "text-foreground" : "text-muted-foreground")}
              onClick={() => onChange(option.list)}
            >
              {option.icon}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{option.label}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

// What the filters and the inactive rule are hiding, with a way back to everything.
export function RunnerFootnote({
  shown,
  total,
  filtered,
  inactiveHidden,
  showingInactive,
  onClearFilters,
  onShowInactive,
}: {
  shown: number;
  total: number;
  filtered: boolean;
  inactiveHidden: number;
  showingInactive: boolean;
  onClearFilters: () => void;
  onShowInactive: (show: boolean) => void;
}) {
  if (!filtered && inactiveHidden === 0 && !showingInactive) return null;
  const link =
    "rounded-sm font-medium text-ink-2 underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50";
  const inactive = plural(inactiveHidden, "runner");
  return (
    <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-muted-foreground">
      {filtered && (
        <span>
          {shown === 0 ? "No runners match these filters." : `Showing ${shown} of ${total}.`}{" "}
          <button type="button" className={link} onClick={onClearFilters}>
            Clear filters
          </button>
        </span>
      )}
      {inactiveHidden > 0 && (
        <span>
          {inactive} inactive for over {INACTIVE_DAYS} days {inactiveHidden === 1 ? "is" : "are"}{" "}
          hidden.{" "}
          <button type="button" className={link} onClick={() => onShowInactive(true)}>
            Show
          </button>
        </span>
      )}
      {showingInactive && (
        <button type="button" className={link} onClick={() => onShowInactive(false)}>
          Hide runners inactive for over {INACTIVE_DAYS} days
        </button>
      )}
    </p>
  );
}
