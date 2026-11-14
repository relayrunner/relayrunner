import { createFileRoute } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  CircleDollarSignIcon,
  GaugeIcon,
  LayersIcon,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { Count } from "@/components/count";
import { PageHeader } from "@/components/page-header";
import { RangePicker } from "@/components/range-picker";
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
  getSignals,
  type Signal,
  type SignalArea,
  SIGNAL_COPY,
  type SignalRow,
  type SignalsReport,
  sampleSignals,
} from "@/lib/signals";
import { money } from "@/lib/usage";
import { count } from "@/lib/utils";

const RANGES = [7, 30, 90] as const;

const AREA_ICONS: Record<SignalArea, LucideIcon> = {
  speed: GaugeIcon,
  cost: CircleDollarSignIcon,
  complexity: LayersIcon,
};

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
  const Icon = AREA_ICONS[area];
  const { title, question } = AREAS[area];
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
            <TableHead className="w-28 text-right">Spend</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {signal.rows.map((row) => (
            <TableRow key={`${row.repository}:${row.subject}`}>
              <TableCell className="truncate">
                <Subject row={row} />
              </TableCell>
              <TableCell className="text-right tabular-nums">
                <Count value={row.count} />
              </TableCell>
              <TableCell className="text-right font-medium tabular-nums">
                <Count value={row.minutes} />
              </TableCell>
              <TableCell className="text-right tabular-nums">{money(row.cost)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// "acme/web / CI", linking to the workflow file on GitHub when the run said which file it was.
function Subject({ row }: { row: SignalRow }) {
  const text = (
    <>
      <span className="text-muted-foreground">{row.repository} / </span>
      {row.subject}
    </>
  );
  if (!row.workflowPath) return text;
  return (
    <a
      href={`https://github.com/${row.repository}/blob/HEAD/${row.workflowPath}`}
      target="_blank"
      rel="noreferrer"
      className="hover:underline"
    >
      {text}
    </a>
  );
}
