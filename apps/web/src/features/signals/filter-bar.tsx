// The bar that names a filtered Signals page's filters and clears them.
import { XIcon } from "lucide-react";
import {
  folderName,
  FILTER_KEYS,
  type FilterKey,
  type SignalFilter,
  type SignalsReport,
  triggerName,
} from "@/lib/signals";
import { useSetSearch } from "@/lib/search-params";
import { type TimeRange } from "@/lib/time-range";
import { type Search, NO_FILTER } from "@/features/signals/search";
import { WorkflowName, SubjectText, Trend } from "@/features/signals/signal-card";

const FILTER_LABELS: Record<FilterKey, string> = {
  person: "Person",
  repo: "Repository",
  workflow: "Workflow",
  branch: "Branch",
  trigger: "Trigger",
  path: "Folder",
};

// What the page is narrowed to, each value with a button to drop it, and the filter's trend.
export function FilterBar({
  filter,
  report,
  range,
}: {
  filter: SignalFilter;
  report: SignalsReport;
  range: TimeRange;
}) {
  const setSearch = useSetSearch<Search>();
  // A workflow or folder shows with its repo, and goes with it, so the repo shows on its own only
  // without one.
  const shown = FILTER_KEYS.filter(
    (key) => filter[key] && !(key === "repo" && (filter.workflow || filter.path)),
  );
  const parts = shown.map((key) => {
    const value = filter[key]!;
    if (key === "workflow") {
      const path = report.breakdown.workflow.rows[0]?.workflowPath ?? null;
      return {
        label: FILTER_LABELS[key],
        value: <WorkflowName repository={filter.repo ?? ""} name={value} path={path} />,
        clear: { workflow: undefined, repo: filter.path ? filter.repo : undefined },
      };
    }
    if (key === "path") {
      return {
        label: FILTER_LABELS[key],
        value: <SubjectText repository={filter.repo ?? ""} name={folderName(value)} />,
        clear: { path: undefined, repo: filter.workflow ? filter.repo : undefined },
      };
    }
    return {
      label: FILTER_LABELS[key],
      value: key === "trigger" ? triggerName(value) : value,
      clear: { [key]: undefined },
    };
  });

  return (
    <div className="grid gap-4 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        {parts.map(({ label, value, clear }) => (
          <span key={label} className="inline-flex min-w-0 items-center gap-1.5">
            <span className="text-muted-foreground">{label}</span>
            <span className="truncate font-medium">{value}</span>
            <button
              type="button"
              aria-label={`Remove the ${label.toLowerCase()} filter`}
              onClick={() => setSearch(clear)}
              className="rounded-xs p-0.5 text-muted-foreground hover:text-foreground"
            >
              <XIcon aria-hidden className="size-3.5" />
            </button>
          </span>
        ))}
        {parts.length > 1 && (
          <button
            type="button"
            onClick={() => setSearch(NO_FILTER)}
            className="ml-auto text-muted-foreground hover:text-foreground"
          >
            Clear all
          </button>
        )}
      </div>
      {report.trend && <Trend trend={report.trend} range={range} />}
    </div>
  );
}
