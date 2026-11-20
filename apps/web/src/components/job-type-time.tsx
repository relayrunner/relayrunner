// The Performance page's Job types tab: where CI time goes by what each job does, from the AI
// model's job types (apps/api/src/ai/job-type.ts). A share bar and table for the window, and the
// minutes on each day stacked by type.
import { Link } from "@tanstack/react-router";
import { ArrowDownIcon, ArrowUpIcon, ChevronRightIcon } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { Count } from "@/components/count";
import { ChartTip, TipRow, topRounded, useWidth } from "@/components/chart-parts";
import { TypePhases } from "@/components/job-phases";
import { authDisabled } from "@/lib/auth-client";
import { DAY_MS, minutesText, plural } from "@/lib/job-times";
import {
  change,
  getJobTypeTimes,
  type JobTypeTime,
  type JobTypeTimes,
  sampleJobTypeTimes,
  summarize,
  typeColor,
  type TypeKey,
  typeLabel,
  type TypeSummary,
  type TypeTotal,
} from "@/lib/job-types";
import { shortDate, zoneFormat } from "@/lib/time-zone";
import { rangeDays, rangePhrase, type TimeRange, trendPhrase } from "@/lib/time-range";
import { cn, count, percent } from "@/lib/utils";

const load = (range: TimeRange) =>
  authDisabled ? Promise.resolve(sampleJobTypeTimes(rangeDays(range))) : getJobTypeTimes(range);

const share = (ms: number, total: number) => percent(total ? ms / total : 0);

/** The average job's minutes, such as "3.2 min". */
const perJob = (ms: number, runs: number) =>
  runs ? `${(ms / runs / 60_000).toFixed(1)} min` : "–";

/** A type's fill: its color, with stripes for jobs not sorted yet. */
const fill = (key: TypeKey) =>
  key === "none"
    ? `repeating-linear-gradient(135deg, ${typeColor(key)} 0 2px, transparent 2px 5px)`
    : typeColor(key);

/** The same fill for an SVG mark, the stripes coming from Daily's pattern. */
const svgFill = (key: TypeKey) => (key === "none" ? `url(#${HATCH})` : typeColor(key));
const HATCH = "job-type-hatch";

// Table cells, shared by type rows and their job rows.
const NUMBER = "px-2 text-right tabular-nums";
const PHONE_HIDDEN = "hidden sm:table-cell";
const HEAD = "px-2 py-1.5 text-right font-medium";

function Swatch({ type, className }: { type: TypeKey; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-2.5 shrink-0 rounded-[3px]", className)}
      style={{ background: fill(type) }}
    />
  );
}

export function JobTypes({ range, repository }: { range: TimeRange; repository: string }) {
  const [report, setReport] = useState<JobTypeTimes | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setFailed(false);
    load(range)
      .then((next) => live && setReport(next))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [range]);
  const summary = useMemo(() => report && summarize(report, repository), [report, repository]);

  if (failed) return <Empty>Job types didn't load. Try again in a moment.</Empty>;
  if (!report || !summary)
    return (
      <div aria-busy aria-label="Loading" className="h-64 animate-pulse rounded-xl bg-muted" />
    );
  if (summary.runs === 0) return <Empty>No finished jobs in {rangePhrase(range)}.</Empty>;
  const sorted = summary.types.some((type) => type.key !== "none");

  return (
    <div className="grid gap-6">
      {!report.ai && !sorted ? (
        <Empty>
          Job types come from the AI model, which is off for this workspace. Turn it on in{" "}
          <Link to="/settings/general" className="text-foreground underline underline-offset-4">
            Settings
          </Link>{" "}
          to see where your CI time goes.
        </Empty>
      ) : (
        <>
          <Shares summary={summary} range={range} compare={report.compare} />
          {report.days > 1 && <Daily summary={summary} />}
          <TypePhases summary={summary} />
          <p className="max-w-[62ch] text-sm text-muted-foreground">
            The AI model sorts each job by its name, its workflow and its runner labels, and reads
            new jobs every hour. Jobs it hasn't read yet, or wasn't sure about, count as Not sorted.
          </p>
        </>
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xl border bg-card px-4 py-6 text-sm text-muted-foreground">{children}</p>
  );
}

function Shares({
  summary,
  range,
  compare,
}: {
  summary: TypeSummary;
  range: TimeRange;
  compare: boolean;
}) {
  const [open, setOpen] = useState<TypeKey | null>(null);
  const cell = cn(NUMBER, "py-2");

  return (
    <section className="rounded-xl border bg-card p-4 sm:p-5">
      <h2 className="text-sm font-semibold">Where CI time goes</h2>
      <p className="text-sm text-muted-foreground">
        Run time of finished jobs. Time waiting for a runner isn't counted.
      </p>
      <p className="mt-4 text-3xl font-semibold tabular-nums">
        {minutesText(summary.ms)} min
        <span className="ml-2 text-sm font-normal text-muted-foreground">
          across <Count value={summary.runs} /> jobs
        </span>
      </p>
      <div
        className="mt-3 mb-4 flex h-3.5 gap-0.5"
        role="img"
        aria-label="Share of run time by type"
      >
        {summary.types.map((type) => (
          <span
            key={type.key}
            title={`${typeLabel(type.key)}: ${share(type.ms, summary.ms)}`}
            className="h-full min-w-0.5 first:rounded-l last:rounded-r"
            style={{ width: `${(type.ms / summary.ms) * 100}%`, background: fill(type.key) }}
          />
        ))}
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-xs text-muted-foreground">
            <th className="py-1.5 text-left font-medium">Type</th>
            <th className={HEAD}>Minutes</th>
            <th className={HEAD}>Share</th>
            <th className={cn(HEAD, PHONE_HIDDEN)}>Jobs</th>
            <th className={cn(HEAD, PHONE_HIDDEN)}>Per job</th>
            {compare && (
              <th
                className="py-1.5 pl-2 text-right font-medium"
                title={`Vs. ${trendPhrase(range)}`}
              >
                Change
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {summary.types.map((type) => {
            const expanded = open === type.key;
            return (
              <Fragment key={type.key}>
                <tr className={cn(!expanded && "border-b last:border-0")}>
                  <td className="py-2">
                    <button
                      type="button"
                      aria-expanded={expanded}
                      onClick={() => setOpen(expanded ? null : type.key)}
                      className="flex items-center gap-2 text-left"
                    >
                      <ChevronRightIcon
                        aria-hidden
                        className={cn(
                          "size-3.5 text-muted-foreground transition-transform",
                          expanded && "rotate-90",
                        )}
                      />
                      <Swatch type={type.key} />
                      {typeLabel(type.key)}
                    </button>
                  </td>
                  <td className={cell}>{minutesText(type.ms)}</td>
                  <td className={cell}>{share(type.ms, summary.ms)}</td>
                  <td className={cn(cell, PHONE_HIDDEN)}>
                    <Count value={type.runs} />
                  </td>
                  <td className={cn(cell, PHONE_HIDDEN)}>{perJob(type.ms, type.runs)}</td>
                  {compare && (
                    <td className="py-2 pl-2 text-right whitespace-nowrap text-muted-foreground tabular-nums">
                      <Change total={type} />
                    </td>
                  )}
                </tr>
                {expanded && <TopJobs type={type} total={summary.ms} compare={compare} />}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function Change({ total }: { total: TypeTotal }) {
  const value = change(total);
  if (value === null) return "–";
  if (value === 0) return "0%";
  const Icon = value > 0 ? ArrowUpIcon : ArrowDownIcon;
  return (
    <span className="inline-flex items-center gap-0.5">
      <Icon aria-label={value > 0 ? "Up" : "Down"} className="size-3.5" />
      {Math.abs(value)}%
    </span>
  );
}

// The jobs that take the most of a type's time.
const TOP_JOBS = 5;

function TopJobs({ type, total, compare }: { type: TypeTotal; total: number; compare: boolean }) {
  const shown = type.jobs.slice(0, TOP_JOBS);
  const rest = type.jobs.length - shown.length;
  return (
    <>
      {shown.map((job) => (
        <tr key={`${job.repository}\0${job.workflow}\0${job.job}`} className="text-ink-2">
          <td className="py-1 pl-[22px]">
            <JobName job={job} />
          </td>
          <td className={cn(NUMBER, "py-1")}>{minutesText(job.ms)}</td>
          <td className={cn(NUMBER, "py-1")}>{share(job.ms, total)}</td>
          <td className={cn(NUMBER, "py-1", PHONE_HIDDEN)}>
            <Count value={job.runs} />
          </td>
          <td className={cn(NUMBER, "py-1", PHONE_HIDDEN)}>{perJob(job.ms, job.runs)}</td>
          {compare && <td />}
        </tr>
      ))}
      <tr className="border-b last:border-0">
        <td colSpan={6} className="pt-0.5 pb-2 pl-[22px] text-xs text-muted-foreground">
          {rest > 0 ? `And ${plural(rest, "job")} more` : ""}
        </td>
      </tr>
    </>
  );
}

function JobName({ job }: { job: JobTypeTime }) {
  return (
    <span className="text-sm">
      <span className="text-muted-foreground">
        {job.repository}
        {job.workflow ? ` · ${job.workflow}` : ""} ›
      </span>{" "}
      {job.job}
    </span>
  );
}

const HEIGHT = 200;
const PAD = { top: 10, right: 0, bottom: 22, left: 40 };
// Half a date label's width, about.
const EDGE = 18;
const TIP_LABEL: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" };

type Day = TypeSummary["days"][number];

// 1, 2, 5, 10, 20, 50, ... so the axis lands on round numbers with about three steps.
function roundStep(max: number) {
  for (let scale = 1; ; scale *= 10)
    for (const step of [1, 2, 5]) if (step * scale * 3 >= max) return step * scale;
}

/** Minutes on each day of the window, stacked by type. */
function Daily({ summary }: { summary: TypeSummary }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  // The day under the pointer, by index.
  const [hover, setHover] = useState<number | null>(null);
  const hovered = hover === null ? undefined : summary.days[hover];
  const keys = summary.types.map((type) => type.key);
  const maxMinutes = Math.max(...summary.days.map((day) => day.total), 60_000) / 60_000;
  const step = roundStep(maxMinutes);
  const top = Math.ceil((maxMinutes * 1.05) / step) * step;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const y = (minutes: number) => PAD.top + (1 - minutes / top) * plotHeight;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const slot = width ? (width - PAD.left - PAD.right) / summary.days.length : 0;
  const barWidth = Math.max(Math.min(slot - Math.min(4, slot / 4), 28), 1);
  // About one date label per 70px.
  const labelEvery = Math.max(1, Math.ceil(70 / Math.max(slot, 1)));
  // Labels and the tooltip read midday, so a daylight saving change doesn't move the date.
  const noon = (day: Day) => day.start + DAY_MS / 2;

  return (
    <section className="rounded-xl border bg-card p-4 sm:p-5">
      <h2 className="text-sm font-semibold">Minutes per day</h2>
      <p className="mb-3 text-sm text-muted-foreground">Stacked by type.</p>
      <div ref={ref} className="relative">
        {width > 0 && (
          <svg
            width={width}
            height={HEIGHT}
            role="img"
            aria-label="Run minutes on each day, stacked by job type"
            className="block"
            onPointerLeave={(event) => event.pointerType !== "touch" && setHover(null)}
          >
            {ticks.map((tick) => (
              <g key={tick}>
                <line
                  x1={PAD.left}
                  x2={width - PAD.right}
                  y1={y(tick)}
                  y2={y(tick)}
                  stroke="var(--border)"
                  strokeWidth={1}
                />
                <text
                  x={PAD.left - 8}
                  y={y(tick) + 3.5}
                  textAnchor="end"
                  className="fill-muted-foreground text-[10px] tabular-nums"
                >
                  {count(tick)}
                </text>
              </g>
            ))}
            {summary.days.map((day, i) => {
              const x = PAD.left + i * slot;
              let below = 0;
              const total = day.total / 60_000;
              return (
                <g
                  key={day.start}
                  onPointerEnter={() => setHover(i)}
                  onPointerDown={() => setHover(i)}
                >
                  {/* The whole column is the hover target, not just the bar. */}
                  <rect
                    x={x}
                    y={PAD.top}
                    width={slot}
                    height={plotHeight}
                    fill={hover === i ? "var(--foreground)" : "transparent"}
                    fillOpacity={0.05}
                  />
                  {keys.map((key) => {
                    const minutes = (day.ms[key] ?? 0) / 60_000;
                    if (!minutes) return null;
                    // A 2px gap between stacked segments; the top one gets rounded corners.
                    const gap = below ? 2 : 0;
                    const base = y(below) - gap;
                    below += minutes;
                    const d = topRounded(
                      x + (slot - barWidth) / 2,
                      base,
                      barWidth,
                      Math.max(base - y(below), 1),
                      below >= total - 1e-9 ? 2 : 0,
                    );
                    return <path key={key} d={d} fill={svgFill(key)} />;
                  })}
                  {(summary.days.length - 1 - i) % labelEvery === 0 && (
                    <text
                      // A label too close to the edge ends there, so it isn't cut off.
                      x={Math.min(x + slot / 2, width - PAD.right - EDGE)}
                      y={HEIGHT - 6}
                      textAnchor="middle"
                      className="fill-muted-foreground text-[10px]"
                    >
                      {shortDate(noon(day))}
                    </text>
                  )}
                </g>
              );
            })}
            <defs>
              <pattern
                id={HATCH}
                width={5}
                height={5}
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(45)"
              >
                <rect width={2} height={5} fill={typeColor("none")} />
              </pattern>
            </defs>
          </svg>
        )}
        {hover !== null && hovered && (
          <ChartTip x={PAD.left + (hover + 0.5) * slot} y={PAD.top} width={width}>
            <p className="font-medium">{zoneFormat(TIP_LABEL).format(noon(hovered))}</p>
            {keys.map((key) =>
              hovered.ms[key] ? (
                <TipRow
                  key={key}
                  mark={<Swatch type={key} className="size-2" />}
                  label={typeLabel(key)}
                  value={`${minutesText(hovered.ms[key])} min`}
                />
              ) : null,
            )}
            <TipRow label="Total" value={`${minutesText(hovered.total)} min`} />
          </ChartTip>
        )}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {keys.map((key) => (
          <span key={key} className="inline-flex items-center gap-1.5">
            <Swatch type={key} />
            {typeLabel(key)}
          </span>
        ))}
      </div>
    </section>
  );
}
