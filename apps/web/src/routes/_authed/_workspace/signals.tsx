import { createFileRoute } from "@tanstack/react-router";
import { ArrowUpRightIcon, ChartBarBigIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Count } from "@/components/count";
import { PageHeader } from "@/components/page-header";
import { RangePicker } from "@/components/range-picker";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { authDisabled } from "@/lib/auth-client";
import {
  AREAS,
  BREAKDOWN_VIEWS,
  type BreakdownBy,
  type BreakdownRow,
  getSignals,
  type Signal,
  type SignalArea,
  SIGNAL_COPY,
  type SignalsReport,
  sampleSignals,
  triggerName,
} from "@/lib/signals";
import { money } from "@/lib/usage";
import { count } from "@/lib/utils";

const RANGES = [7, 30, 90] as const;

function load(days: number): Promise<SignalsReport> {
  return authDisabled ? Promise.resolve(sampleSignals(days)) : getSignals(days);
}

export const Route = createFileRoute("/_authed/_workspace/signals")({
  loader: () => load(30),
  component: SignalsPage,
});

function SignalsPage() {
  const first = Route.useLoaderData();
  const [report, setReport] = useState<SignalsReport>(first);
  const [days, setDays] = useState<number>(first.days);

  function chooseRange(next: number) {
    setDays(next);
    load(next)
      .then(setReport)
      .catch(() => undefined);
  }

  const areas = (Object.keys(AREAS) as SignalArea[])
    .map((area) => ({ area, signals: report.signals.filter((signal) => signal.area === area) }))
    .filter(({ signals }) => signals.length > 0);

  return (
    <section>
      <PageHeader title="Signals">
        What makes your CI slow, costly or busier than it needs to be, and where. Updated every
        hour.
      </PageHeader>
      <div className="grid max-w-4xl gap-8">
        <RangePicker ranges={RANGES} days={days} onChange={chooseRange} />
        {areas.length === 0 ? (
          <p className="rounded-xl border bg-card px-4 py-6 text-sm text-muted-foreground">
            {report.totals.jobs === 0
              ? "No finished jobs in this range yet. Signals show up within an hour of jobs running in a connected repo."
              : `Nothing stands out in the last ${report.days} days.`}
          </p>
        ) : (
          areas.map(({ area, signals }) => (
            <AreaSection key={area} area={area} signals={signals} report={report} />
          ))
        )}
        {report.totals.jobs > 0 && <BreakdownSection report={report} />}
      </div>
    </section>
  );
}

function AreaSection({
  area,
  signals,
  report,
}: {
  area: SignalArea;
  signals: Signal[];
  report: SignalsReport;
}) {
  const { title, question, icon: Icon } = AREAS[area];
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex items-center gap-2">
          <Icon aria-hidden className="size-4.5 self-center" />
          <h2 className="font-semibold">{title}</h2>
          <span className="text-muted-foreground">{question}</span>
        </div>
        {area === "cost" && (
          <span className="text-sm text-muted-foreground">
            {money(report.totals.cost)} across {count(report.totals.minutes)} minutes
          </span>
        )}
      </div>
      {signals.map((signal) => (
        <SignalCard key={signal.id} signal={signal} />
      ))}
    </div>
  );
}

function SignalCard({ signal }: { signal: Signal }) {
  const copy = SIGNAL_COPY[signal.id];
  // Signals that cost time but no money keep the column, empty, so columns line up down the page.
  const spend = copy.spend !== false;
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <h3 className="flex items-center gap-1.5 text-[15px] font-medium">
          {copy.title}
          <InfoTip label={copy.title}>{copy.about}</InfoTip>
        </h3>
        <div className="ml-auto flex items-center gap-4 text-sm">
          {copy.action && (
            <a href={copy.action.href} className="font-medium text-primary hover:underline">
              {copy.action.label}
            </a>
          )}
          {copy.docs && (
            <a
              href={copy.docs}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
            >
              Learn more in the GitHub docs
              <ArrowUpRightIcon aria-hidden className="size-3.5" />
            </a>
          )}
        </div>
      </div>
      {/* Fixed columns, so every signal's numbers line up down the page. Phones scroll it. */}
      <Table className="min-w-xl table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead>{copy.subject}</TableHead>
            <TableHead className="w-36 text-right">{copy.count}</TableHead>
            <TableHead className="w-36 text-right">{copy.minutes}</TableHead>
            <TableHead className="w-28 text-right">{spend && "Spend"}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {signal.rows.map((row) => (
            <TableRow key={`${row.repository}:${row.subject}`}>
              <TableCell className="truncate">
                <WorkflowName
                  repository={row.repository}
                  name={row.subject}
                  path={row.workflowPath}
                />
              </TableCell>
              <TableCell className="text-right tabular-nums">
                <Count value={row.count} />
              </TableCell>
              <TableCell className="text-right font-medium tabular-nums">
                <Count value={row.minutes} />
              </TableCell>
              <TableCell className="text-right tabular-nums">{spend && money(row.cost)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// "acme/web / CI", linking to the workflow file on GitHub when the run said which file it was.
function WorkflowName({
  repository,
  name,
  path,
}: {
  repository: string;
  name: string;
  path: string | null;
}) {
  const text = (
    <>
      <span className="text-muted-foreground">{repository} / </span>
      {name}
    </>
  );
  if (!path) return text;
  return (
    <a
      href={`https://github.com/${repository}/blob/HEAD/${path}`}
      target="_blank"
      rel="noreferrer"
      className="hover:underline"
    >
      {text}
    </a>
  );
}

// Every counted job split one way at a time, with each row's share of all job minutes (left out on
// phones, where the table scrolls like the signals above).
function BreakdownSection({ report }: { report: SignalsReport }) {
  const [by, setBy] = useState<BreakdownBy>("person");
  const { rows, other } = report.breakdown[by];
  const view = BREAKDOWN_VIEWS.find((option) => option.value === by)!;
  const total = report.totals.minutes;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <ChartBarBigIcon aria-hidden className="size-4.5 self-center" />
          <h2 className="font-semibold">Breakdown</h2>
          <span className="text-muted-foreground">Who and what uses your CI</span>
        </div>
        <div role="group" aria-label="Break down by" className="flex flex-wrap gap-1.5">
          {BREAKDOWN_VIEWS.map((option) => (
            <Button
              key={option.value}
              size="sm"
              variant={by === option.value ? "secondary" : "ghost"}
              aria-pressed={by === option.value}
              onClick={() => setBy(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>
      <Table className="min-w-xl table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead>{view.label}</TableHead>
            <TableHead className="hidden w-44 sm:table-cell">Share of minutes</TableHead>
            <TableHead className="w-24 text-right">Runs</TableHead>
            <TableHead className="w-24 text-right">Minutes</TableHead>
            <TableHead className="w-28 text-right">Spend</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <BreakdownLine
              key={`${row.repository}:${row.name}`}
              name={<BreakdownName by={by} row={row} />}
              sums={row}
              total={total}
            />
          ))}
          {other && (
            <BreakdownLine
              name={<span className="text-muted-foreground">Everything else</span>}
              sums={other}
              total={total}
            />
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function BreakdownLine({
  name,
  sums,
  total,
}: {
  name: ReactNode;
  sums: { runs: number; minutes: number; cost: number };
  total: number;
}) {
  const share = total ? Math.min(1, sums.minutes / total) : 0;
  return (
    <TableRow>
      <TableCell className="truncate">{name}</TableCell>
      <TableCell className="hidden sm:table-cell">
        <div className="flex items-center gap-2">
          <div aria-hidden className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised-2">
            <div className="h-full rounded-full bg-primary" style={{ width: `${share * 100}%` }} />
          </div>
          <span className="w-9 text-right text-xs text-muted-foreground tabular-nums">
            {Math.round(share * 100)}%
          </span>
        </div>
      </TableCell>
      <TableCell className="text-right tabular-nums">
        <Count value={sums.runs} />
      </TableCell>
      <TableCell className="text-right font-medium tabular-nums">
        <Count value={sums.minutes} />
      </TableCell>
      <TableCell className="text-right tabular-nums">{money(sums.cost)}</TableCell>
    </TableRow>
  );
}

function BreakdownName({ by, row }: { by: BreakdownBy; row: BreakdownRow }) {
  if (by === "workflow" && row.repository) {
    return <WorkflowName repository={row.repository} name={row.name} path={row.workflowPath} />;
  }
  if (by === "trigger") return triggerName(row.name);
  return row.name;
}
