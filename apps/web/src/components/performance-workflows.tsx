// The Performance page's Workflows tab: the window's totals, then a row per workflow with its
// times, cost per run, the runners it ran on and the fastest of them against GitHub. Each row opens
// the workflow's page (routes/_authed/_workspace/performance_.workflow.tsx).
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { memo, useMemo } from "react";
import { Count } from "@/components/count";
import { providerOf, providerStyle, RunnerMark } from "@/components/providers";
import { StatTile } from "@/components/stat-tile";
import { createCellContext, DataTable, dataTableColumns } from "@/components/ui/data-table";
import {
  clock,
  type Environment,
  type JobTimesReport,
  medianText,
  plural,
  runCost,
  type WorkflowRow,
} from "@/lib/job-times";
import { type TimeRange, trendPhrase } from "@/lib/time-range";
import { type ExportColumn, seconds } from "@/lib/table-export";
import { cn, count } from "@/lib/utils";
import { PublicRepoMark } from "@/components/public-repo";

/** Runners that need no provider's name to read: GitHub's images, machines, containers. */
const NAMED_BY_LABEL = new Set(["github", "machine", "self-hosted", "container", "other"]);

/** A runner's short name: its label, or its provider's name for a cloud runner's long label. */
export function runnerTitle(env: Pick<Environment, "key" | "label">) {
  const provider = providerOf(env);
  return NAMED_BY_LABEL.has(provider) ? env.label : providerStyle(provider).name;
}

/**
 * A change as a colored triangle and percent: ▼ green for less time or money, ▲ amber for more.
 * Within 1% it's a plain "Same".
 */
export function Change({ pct, className }: { pct: number | null; className?: string }) {
  if (pct === null) return <span className="text-muted-foreground">—</span>;
  if (pct === 0) return <span className={cn("text-muted-foreground", className)}>Same</span>;
  const less = pct < 0;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 font-medium whitespace-nowrap tabular-nums",
        less ? "text-go" : "text-run",
        className,
      )}
    >
      <span aria-hidden className="text-[10px]">
        {less ? "▼" : "▲"}
      </span>
      <span className="sr-only">{less ? "down" : "up"}</span>
      {Math.abs(pct)}%
    </span>
  );
}

/** The runners a workflow ran on, as marks, `max` of them and "+N" for the rest. */
function RunnerMarks({ keys, environments }: { keys: string[]; environments: Environment[] }) {
  const max = 4;
  const byKey = new Map(environments.map((env) => [env.key, env]));
  return (
    <span className="flex items-center gap-2">
      <span className="flex gap-1">
        {keys.slice(0, max).map((key) => {
          const env = byKey.get(key) ?? { key, label: key };
          return (
            <span key={key} title={runnerTitle(env)}>
              <RunnerMark runner={env} className="size-5 rounded-[5px]" />
            </span>
          );
        })}
      </span>
      {keys.length > max && (
        <span className="text-xs text-muted-foreground">+{keys.length - max}</span>
      )}
    </span>
  );
}

type Row = WorkflowRow & { id: string };

/** Runs a day over the range: "12", "2.5", or "<0.1" for a workflow that hardly runs. */
function perDayText(runs: number, days: number) {
  const perDay = runs / Math.max(1, days);
  if (perDay >= 10) return count(Math.round(perDay));
  if (perDay >= 0.1) return String(Math.round(perDay * 10) / 10);
  return "<0.1";
}

function PerDay({ runs }: { runs: number | undefined }) {
  const { days } = useContext();
  return runs === undefined ? "—" : perDayText(runs, days);
}

const [Context, useContext] = createCellContext<{
  showRepository: boolean;
  range: TimeRange;
  environments: Environment[];
  days: number;
}>("Workflows");

// A workflow's export: its run counts and times in seconds, and its cost in USD.
const EXPORT_COLUMNS: ExportColumn<Row>[] = [
  { header: "Repo", value: (row) => row.repository },
  { header: "Workflow", value: (row) => row.workflow },
  { header: "Runs", value: (row) => row.wall?.runs ?? 0 },
  { header: "Passed", value: (row) => row.wall?.successes ?? 0 },
  { header: "Median (s)", value: (row) => seconds(row.wall?.medianMs) },
  { header: "p90 (s)", value: (row) => seconds(row.wall?.p90Ms) },
  { header: "Waiting (s)", value: (row) => seconds(row.wall?.waitMs) },
  { header: "Cost per run (USD)", value: (row) => row.usd },
  { header: "Spent (USD)", value: (row) => row.spentUsd },
];

const END = { align: "end" } as const;
const column = dataTableColumns<Row>();
const columns = column.columns([
  column.accessor((row) => row.workflow ?? "", {
    id: "workflow",
    header: "Workflow",
    sortFn: "text",
    cell: ({ row }) => <WorkflowCell row={row.original} />,
  }),
  column.accessor((row) => row.wall?.runs, {
    id: "runs",
    header: "Runs",
    sortFn: "basic",
    sortDescFirst: true,
    meta: { ...END, hideOnPhone: true },
    cell: ({ getValue }) => {
      const runs = getValue();
      return runs === undefined ? "—" : <Count value={runs} />;
    },
  }),
  column.accessor((row) => row.wall?.runs, {
    id: "perDay",
    header: "Per day",
    sortFn: "basic",
    sortDescFirst: true,
    meta: { ...END, hideOnPhone: true },
    cell: ({ getValue }) => <PerDay runs={getValue()} />,
  }),
  column.accessor((row) => (row.wall?.runs ? row.wall.successes / row.wall.runs : undefined), {
    id: "passed",
    header: "Passed",
    sortFn: "basic",
    sortDescFirst: true,
    meta: {
      ...END,
      hideOnPhone: true,
    },
    cell: ({ getValue }) => {
      const share = getValue();
      return share === undefined ? "—" : `${Math.round(share * 100)}%`;
    },
  }),
  column.accessor((row) => row.wall?.medianMs ?? undefined, {
    id: "median",
    header: "Median",
    sortFn: "basic",
    sortDescFirst: true,
    meta: {
      align: "end",
      className: "font-semibold whitespace-nowrap",
      info: <MedianInfo />,
    },
    cell: ({ row: { original } }) => <MedianCell row={original} />,
  }),
  column.accessor((row) => row.wall?.waitMs ?? undefined, {
    id: "waiting",
    header: "Waiting",
    sortFn: "basic",
    sortDescFirst: true,
    meta: {
      ...END,
      hideOnPhone: true,
      info: (
        <p>
          The part of the median spent with no job running, mostly waiting for a runner. The rest is
          jobs running.
        </p>
      ),
    },
    cell: ({ row: { original } }) => (
      <span className="text-muted-foreground">{clock(original.wall?.waitMs ?? null)}</span>
    ),
  }),
  column.accessor((row) => row.usd ?? undefined, {
    id: "usd",
    header: "Cost per run",
    sortFn: "basic",
    sortDescFirst: true,
    meta: {
      ...END,
      className: "whitespace-nowrap",
      info: (
        <p>
          The median successful run at list prices: each job's billed minutes times its runner's
          price. Machines, self-hosted runners and public repos on GitHub are free. Free minutes and
          discounts aren't counted.
        </p>
      ),
    },
    cell: ({ getValue }) => runCost(getValue()),
  }),
  column.accessor((row) => row.environments.length, {
    id: "ran",
    header: "Ran on",
    enableSorting: false,
    meta: { hideOnPhone: true },
    cell: ({ row }) => <RanOnCell row={row.original} />,
  }),
  column.accessor((row) => row.fastest?.ratio, {
    id: "fastest",
    header: "Fastest vs GitHub",
    enableSorting: false,
    meta: {
      hideOnPhone: true,
      className: "whitespace-nowrap",
      info: (
        <p>
          The runner with the shortest median against ubuntu-latest, from runs that ran every job
          there. Each needs 5 or more of them.
        </p>
      ),
    },
    cell: ({ row }) => <FastestCell row={row.original} />,
  }),
  column.display({
    id: "open",
    header: "",
    meta: { className: "w-6 px-0 pr-3" },
    cell: () => <ChevronRightIcon aria-hidden className="size-4 text-muted-foreground" />,
  }),
]);

function MedianInfo() {
  const { range } = useContext();
  return (
    <>
      <p>
        From the start of a run to its last job finishing, over successful runs. It includes time
        jobs spent waiting for a runner.
      </p>
      <p>After it, the change against {trendPhrase(range)}: ▲ slower, ▼ faster.</p>
    </>
  );
}

/** The median with its change against the stretch before, when there is one. */
function MedianCell({ row }: { row: Row }) {
  if (!row.wall) return <>—</>;
  const trend = row.wall.trend;
  return (
    <span className="inline-flex items-center gap-2">
      {medianText(row.wall)}
      {/* A fixed width, so the changes line up down the column. */}
      <span className="inline-flex w-12 items-center">
        {trend !== null && <Change pct={Math.round(trend * 100)} className="text-xs font-normal" />}
      </span>
    </span>
  );
}

function WorkflowCell({ row }: { row: Row }) {
  const { showRepository, range } = useContext();
  return (
    <>
      {/* Stretched over the row, so the whole row opens the workflow. */}
      <Link
        to="/performance/workflow"
        search={{ repo: row.repositoryId, workflow: row.workflow ?? undefined, range }}
        title={row.workflow ?? undefined}
        className="block w-fit max-w-56 truncate font-medium outline-none after:absolute after:inset-0 hover:underline hover:underline-offset-2 focus-visible:after:ring-2 focus-visible:after:ring-ring"
      >
        {row.workflow ?? "Unnamed workflow"}
      </Link>
      <span className="block max-w-56 truncate text-xs text-muted-foreground">
        {showRepository && (
          <>
            {row.repository}
            <PublicRepoMark repository={row.repository} />
            {" · "}
          </>
        )}
        {plural(row.jobs.length, "job")}
      </span>
    </>
  );
}

function RanOnCell({ row }: { row: Row }) {
  const { environments } = useContext();
  if (row.environments.length === 0) return <span className="text-muted-foreground">—</span>;
  return <RunnerMarks keys={row.environments} environments={environments} />;
}

function FastestCell({ row }: { row: Row }) {
  const { environments } = useContext();
  if (!row.fastest) {
    const onlyGitHub =
      row.environments.length > 0 && row.environments.every((key) => key.startsWith("github:"));
    return <span className="text-muted-foreground">{onlyGitHub ? "Only GitHub so far" : "—"}</span>;
  }
  const { environment, ratio } = row.fastest;
  const env = environments.find((each) => each.key === environment) ?? {
    key: environment,
    label: environment,
  };
  return (
    <span className="flex items-center gap-2">
      <span className="max-w-40 truncate" title={runnerTitle(env)}>
        {runnerTitle(env)}
      </span>
      <Change pct={Math.round((ratio - 1) * 100)} />
    </span>
  );
}

/** "6.6K min" of CI time, "45 min" under a thousand. */
function minutesText(ms: number) {
  const minutes = ms / 60_000;
  if (minutes >= 10_000) return `${Math.round(minutes / 1000)}K min`;
  if (minutes >= 1000) return `${(minutes / 1000).toFixed(1)}K min`;
  return `${Math.round(minutes)} min`;
}

export const PerformanceWorkflows = memo(function PerformanceWorkflows({
  report,
  workflows,
  showRepository,
  range,
}: {
  report: JobTimesReport;
  /** The report's workflows, narrowed to the repo picked. */
  workflows: WorkflowRow[];
  showRepository: boolean;
  range: TimeRange;
}) {
  const rows = useMemo(
    () =>
      workflows.map((workflow) => ({
        ...workflow,
        id: `${workflow.repositoryId}/${workflow.workflow ?? ""}`,
      })),
    [workflows],
  );
  const context = useMemo(
    () => ({ showRepository, range, environments: report.environments, days: report.days }),
    [showRepository, range, report.environments, report.days],
  );
  // From the workflows shown, so picking a repo narrows the tiles too.
  const totals = useMemo(() => {
    const used = new Set(workflows.flatMap((workflow) => workflow.environments));
    const sum = (of: (workflow: WorkflowRow) => number) =>
      workflows.reduce((total, workflow) => total + of(workflow), 0);
    return {
      runMs: sum((workflow) => workflow.runMs),
      usd: sum((workflow) => workflow.spentUsd),
      runs: sum((workflow) => workflow.wall?.runs ?? 0),
      successes: sum((workflow) => workflow.wall?.successes ?? 0),
      environments: used.size,
      providers: new Set([...used].map((key) => providerOf({ key }))).size,
    };
  }, [workflows]);
  return (
    <div className="grid gap-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile
          label="CI time"
          value={minutesText(totals.runMs)}
          detail={`Across ${plural(workflows.length, "workflow")}`}
        />
        <StatTile
          label="At list prices"
          value={totals.usd >= 100 ? `$${Math.round(totals.usd)}` : `$${totals.usd.toFixed(2)}`}
          detail={totals.runs ? `${runCost(totals.usd / totals.runs)} a run` : undefined}
        />
        <StatTile
          label="Runs"
          value={<Count value={totals.runs} />}
          detail={
            totals.runs
              ? `${Math.round((totals.successes / totals.runs) * 100)}% passed`
              : undefined
          }
        />
        <StatTile
          label="Runners used"
          value={totals.environments}
          detail={`From ${plural(totals.providers, "provider")}`}
        />
      </div>
      {/* Tighter cells than other tables, so nine columns fit beside the sidebar. */}
      <div className="min-w-0 sm:[&_td]:px-3 sm:[&_th]:px-3">
        <Context value={context}>
          <DataTable
            columns={columns}
            data={rows}
            getRowId={(row) => row.id}
            initialSorting={[{ id: "runs", desc: true }]}
            exportAs={{ name: "workflows", columns: EXPORT_COLUMNS }}
            rowClassName={() => "relative hover:bg-secondary/30"}
            empty="No workflows in this repo in the window."
          />
        </Context>
      </div>
    </div>
  );
});
