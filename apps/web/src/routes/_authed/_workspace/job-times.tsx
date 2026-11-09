import { createFileRoute } from "@tanstack/react-router";
import { ChevronDownIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/page-header";
import { RangePicker } from "@/components/range-picker";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { authDisabled } from "@/lib/auth-client";
import {
  type AccountMinutes,
  DAY_MS,
  environmentColor,
  type EnvironmentSummary,
  getActionsUsage,
  getJobTimes,
  type JobRow,
  type JobTimesReport,
  type Minutes,
  sampleActionsUsage,
  sampleJobTimes,
  type Stat,
  type WorkflowRow,
} from "@/lib/job-times";
import { cn } from "@/lib/utils";

const RANGES = [7, 14, 30] as const;

function load(days: number) {
  return authDisabled ? Promise.resolve(sampleJobTimes(days)) : getJobTimes(days);
}

function loadUsage() {
  return authDisabled ? Promise.resolve(sampleActionsUsage()) : getActionsUsage();
}

export const Route = createFileRoute("/_authed/_workspace/job-times")({
  loader: () => load(14),
  component: JobTimesPage,
});

/** Where a run's minutes went. GitHub-hosted splits by whether the repo draws on the quota. */
type Where = "machine" | "cloud" | "free" | "quota";

const WHERE: Record<Where, { label: string; color: string; opacity: number }> = {
  machine: { label: "Your machines", color: "#3fb950", opacity: 1 },
  cloud: { label: "Other cloud", color: "#58a6ff", opacity: 1 },
  free: { label: "GitHub, public repos", color: "#e3b341", opacity: 0.35 },
  quota: { label: "GitHub quota", color: "#e3b341", opacity: 1 },
};
const WHERE_ORDER: Where[] = ["machine", "cloud", "free", "quota"];

function whereOf(env: EnvironmentSummary, workflow: WorkflowRow): Where {
  if (env.kind === "machine") return "machine";
  if (env.kind === "cloud") return "cloud";
  // Unknown visibility counts as private, like the Usage page, so a cost is never hidden.
  return workflow.private === false ? "free" : "quota";
}

type RunnerLine = {
  env: EnvironmentSummary;
  color: string;
  where: Where;
  minutes: Minutes;
  stat?: Stat;
};

type JobLine = {
  key: string;
  workflow: WorkflowRow;
  job: JobRow;
  runners: RunnerLine[];
  runs: number;
  runMs: number;
  quotaMinutes: number;
  dailyMs: number[];
  byWhere: Record<Where, number>;
};

function emptyWhere(): Record<Where, number> {
  return { machine: 0, cloud: 0, free: 0, quota: 0 };
}

/** One line per job (matrix legs folded into their job), most minutes first. */
function jobLines(report: JobTimesReport, workflows: WorkflowRow[]): JobLine[] {
  const envs = new Map(report.environments.map((env, index) => [env.key, { env, index }]));
  const lines: JobLine[] = [];
  for (const workflow of workflows) {
    for (const job of workflow.jobs) {
      const runners: RunnerLine[] = [];
      for (const [key, minutes] of Object.entries(job.minutes ?? {})) {
        const found = envs.get(key);
        if (!found || !minutes.runs) continue;
        runners.push({
          env: found.env,
          color: environmentColor(found.index),
          where: whereOf(found.env, workflow),
          minutes,
          stat: job.byEnvironment[key],
        });
      }
      if (!runners.length) continue;
      runners.sort((a, b) => b.minutes.runMs - a.minutes.runMs);
      const byWhere = emptyWhere();
      const dailyMs = Array.from({ length: report.days }, () => 0);
      for (const runner of runners) {
        byWhere[runner.where] += runner.minutes.runMs;
        runner.minutes.dailyMs.forEach((ms, day) => {
          dailyMs[day] = (dailyMs[day] ?? 0) + ms;
        });
      }
      lines.push({
        key: `${workflow.repositoryId}/${workflow.workflow ?? ""}/${job.name}`,
        workflow,
        job,
        runners,
        runs: runners.reduce((sum, runner) => sum + runner.minutes.runs, 0),
        runMs: runners.reduce((sum, runner) => sum + runner.minutes.runMs, 0),
        quotaMinutes: runners.reduce((sum, runner) => sum + runner.minutes.quotaMinutes, 0),
        dailyMs,
        byWhere,
      });
    }
  }
  return lines.sort((a, b) => b.runMs - a.runMs);
}

/** "0.4", "7.5", "1,240": minutes, with a decimal only while it matters. */
function minutesText(ms: number) {
  const minutes = ms / 60_000;
  if (minutes === 0) return "0";
  if (minutes < 10) return minutes.toFixed(1);
  return Math.round(minutes).toLocaleString();
}

/** "26s", "1m 18s", "4m": a job's typical length. */
function durationText(ms: number | null) {
  if (ms === null) return "—";
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

function percent(part: number, whole: number) {
  return whole ? `${Math.round((part / whole) * 100)}%` : "0%";
}

/** A job's typical run: its runners' medians weighted by the runs behind them. */
function typicalRun(runners: RunnerLine[]) {
  let weight = 0;
  let sum = 0;
  for (const runner of runners) {
    if (!runner.stat?.medianMs || !runner.stat.samples) continue;
    sum += runner.stat.medianMs * runner.stat.samples;
    weight += runner.stat.samples;
  }
  return { ms: weight ? sum / weight : null, few: weight < 5 };
}

function JobTimesPage() {
  const first = Route.useLoaderData();
  const [report, setReport] = useState<JobTimesReport>(first);
  // Day buckets end at the time of the read.
  const [readAt, setReadAt] = useState(() => Date.now());
  const [repository, setRepository] = useState<string>("all");
  const [scope, setScope] = useState<string | null>(null);
  const [usage, setUsage] = useState<AccountMinutes[] | null>(null);

  useEffect(() => {
    loadUsage()
      .then((result) => setUsage(result.accounts))
      .catch(() => undefined);
  }, []);

  function chooseRange(days: number) {
    load(days)
      .then((next) => {
        setReport(next);
        setReadAt(Date.now());
      })
      .catch(() => undefined);
  }

  const repositories = useMemo(
    () => [...new Set(report.workflows.map((workflow) => workflow.repository))].sort(),
    [report],
  );
  const lines = useMemo(
    () =>
      jobLines(
        report,
        repository === "all"
          ? report.workflows
          : report.workflows.filter((workflow) => workflow.repository === repository),
      ),
    [report, repository],
  );
  const scoped = lines.find((line) => line.key === scope) ?? null;

  return (
    <section>
      <PageHeader title="Job times">
        Where your CI minutes went: your own machines, GitHub's quota, or another cloud.
      </PageHeader>
      <div className="grid gap-6">
        <div className="flex flex-wrap items-center gap-3">
          <RangePicker ranges={RANGES} days={report.days} onChange={chooseRange} />
          {repositories.length > 1 && (
            <Select
              value={repository}
              onValueChange={(value) => {
                setRepository(value);
                setScope(null);
              }}
            >
              <SelectTrigger size="sm" aria-label="Repo">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All repos</SelectItem>
                {repositories.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        {lines.length === 0 ? (
          <p className="rounded-xl border bg-card px-4 py-6 text-sm text-muted-foreground">
            No finished jobs in the last {report.days} days. Jobs show up here once the GitHub App
            sees them run in a connected repo.
          </p>
        ) : (
          <>
            <MinutesCard
              report={report}
              readAt={readAt}
              lines={scoped ? [scoped] : lines}
              scoped={scoped}
              usage={usage}
              onClearScope={() => setScope(null)}
            />
            <Jobs
              lines={lines}
              readAt={readAt}
              days={report.days}
              scope={scope}
              onScope={(key) => setScope(scope === key ? null : key)}
            />
            <p className="max-w-[80ch] text-sm text-muted-foreground">
              Minutes are time on the runner, every run counted. Quota min is what GitHub charges
              against your included minutes, in Linux 2-core minutes: only GitHub-hosted jobs in
              private repos count, and GitHub rounds every job up to a whole minute. Your machines
              never touch a quota. Typical run is the median of successful runs.
            </p>
          </>
        )}
      </div>
    </section>
  );
}

function dayLabel(readAt: number, days: number, index: number, long = true) {
  const date = new Date(readAt - (days - 1 - index) * DAY_MS);
  return date.toLocaleDateString(
    undefined,
    long
      ? { weekday: "short", month: "short", day: "numeric" }
      : { month: "numeric", day: "numeric" },
  );
}

type Mode = "where" | "runner";

type Series = { key: string; label: string; color: string; opacity: number; dailyMs: number[] };

function MinutesCard({
  report,
  readAt,
  lines,
  scoped,
  usage,
  onClearScope,
}: {
  report: JobTimesReport;
  readAt: number;
  lines: JobLine[];
  scoped: JobLine | null;
  usage: AccountMinutes[] | null;
  onClearScope: () => void;
}) {
  const [mode, setMode] = useState<Mode>("where");
  const days = report.days;

  const byWhere = emptyWhere();
  let runs = 0;
  let quotaMinutes = 0;
  for (const line of lines) {
    for (const where of WHERE_ORDER) byWhere[where] += line.byWhere[where];
    runs += line.runs;
    quotaMinutes += line.quotaMinutes;
  }
  const totalMs = WHERE_ORDER.reduce((sum, where) => sum + byWhere[where], 0);

  const series: Series[] = [];
  if (mode === "where") {
    for (const where of WHERE_ORDER) {
      const dailyMs = Array.from({ length: days }, () => 0);
      for (const line of lines)
        for (const runner of line.runners)
          if (runner.where === where)
            runner.minutes.dailyMs.forEach((ms, day) => {
              dailyMs[day] = (dailyMs[day] ?? 0) + ms;
            });
      if (dailyMs.some(Boolean)) series.push({ key: where, ...WHERE[where], dailyMs });
    }
  } else {
    report.environments.forEach((env, index) => {
      const dailyMs = Array.from({ length: days }, () => 0);
      for (const line of lines)
        for (const runner of line.runners)
          if (runner.env.key === env.key)
            runner.minutes.dailyMs.forEach((ms, day) => {
              dailyMs[day] = (dailyMs[day] ?? 0) + ms;
            });
      if (dailyMs.some(Boolean))
        series.push({
          key: env.key,
          label: env.label,
          color: environmentColor(index),
          opacity: 1,
          dailyMs,
        });
    });
  }

  // The billing cycle across the workspace's GitHub accounts that report a quota.
  const cycle = (usage ?? []).filter((account) => account.status === "ok" && account.quotaMinutes);
  const cycleQuota = cycle.reduce((sum, account) => sum + (account.quotaMinutes ?? 0), 0);
  const cycleUsed = cycle.reduce((sum, account) => sum + account.usedMinutes, 0);

  const tiles = [
    {
      where: "machine" as const,
      value: minutesText(byWhere.machine),
      unit: "min",
      note: `${percent(byWhere.machine, totalMs)} of all minutes · no quota, no bill`,
    },
    {
      where: "cloud" as const,
      value: minutesText(byWhere.cloud),
      unit: "min",
      note: `${percent(byWhere.cloud, totalMs)} · billed by the provider`,
    },
    {
      where: "free" as const,
      value: minutesText(byWhere.free),
      unit: "min",
      note: `${percent(byWhere.free, totalMs)} · free, outside the quota`,
    },
    {
      where: "quota" as const,
      value: Math.round(quotaMinutes).toLocaleString(),
      unit: "min charged",
      note: `${minutesText(byWhere.quota)} min of work, rounded up per job`,
    },
  ];

  return (
    <section aria-label="Minutes" className="overflow-hidden rounded-xl border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
        {scoped ? (
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <span className="text-muted-foreground">Showing</span>
            <span className="flex min-w-0 items-center gap-1.5 rounded-full border bg-secondary py-1 pr-1 pl-3">
              <span className="whitespace-nowrap text-muted-foreground">
                {scoped.workflow.workflow ?? "Unnamed workflow"} ›
              </span>
              <span className="truncate font-semibold">{scoped.job.name}</span>
              <button
                type="button"
                aria-label="Show all jobs"
                onClick={onClearScope}
                className="flex size-6 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <XIcon aria-hidden className="size-3.5" />
              </button>
            </span>
          </div>
        ) : (
          <div className="grid gap-0.5">
            <p className="text-[17px] font-semibold">
              <span className="text-go">{minutesText(totalMs)} minutes</span> of CI across{" "}
              {runs.toLocaleString()} {runs === 1 ? "job" : "jobs"}
            </p>
            <p className="text-sm text-muted-foreground">
              Last {days} days · pick a job below to chart it on its own
            </p>
          </div>
        )}
        <div
          role="group"
          aria-label="Group chart by"
          className="flex gap-0.5 rounded-lg border bg-background p-0.5"
        >
          {(
            [
              ["where", "Where it ran"],
              ["runner", "By runner"],
            ] as const
          ).map(([value, label]) => (
            <Button
              key={value}
              size="sm"
              variant={mode === value ? "secondary" : "ghost"}
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
              className="h-7"
            >
              {label}
            </Button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-px border-b bg-border">
        {tiles.map((tile) => (
          <div key={tile.where} className="grid content-start gap-1 bg-card px-5 py-3.5">
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <span
                aria-hidden
                className="size-2 rounded-[2px]"
                style={{ background: WHERE[tile.where].color, opacity: WHERE[tile.where].opacity }}
              />
              {WHERE[tile.where].label}
            </span>
            <span className="text-2xl font-semibold tracking-tight tabular-nums">
              {tile.value}{" "}
              <span className="text-sm font-normal text-muted-foreground">{tile.unit}</span>
            </span>
            <span className="text-xs text-muted-foreground">{tile.note}</span>
            {tile.where === "quota" && cycleQuota > 0 && (
              <>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-border">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.min(100, (cycleUsed / cycleQuota) * 100)}%`,
                      background: WHERE.quota.color,
                    }}
                  />
                </div>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {Math.round(cycleUsed).toLocaleString()} of {cycleQuota.toLocaleString()} used
                  this month
                </span>
              </>
            )}
          </div>
        ))}
      </div>

      <Chart series={series} days={days} readAt={readAt} />
    </section>
  );
}

/** A tidy axis step for `max` minutes: about 3 to 4 gridlines. */
function niceStep(maxMinutes: number) {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 180, 300, 600, 1200, 3000, 6000];
  return steps.find((step) => (maxMinutes * 1.1) / step <= 4) ?? 6000;
}

function axisLabel(minutes: number) {
  return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

const PLOT_HEIGHT = 220;

function Chart({ series, days, readAt }: { series: Series[]; days: number; readAt: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const totals = Array.from({ length: days }, (_, day) =>
    series.reduce((sum, item) => sum + (item.dailyMs[day] ?? 0), 0),
  );
  const maxMinutes = Math.max(1, ...totals.map((ms) => ms / 60_000));
  const step = niceStep(maxMinutes);
  const top = Math.ceil((maxMinutes * 1.1) / step) * step;
  const height = (ms: number) => (ms / 60_000 / top) * PLOT_HEIGHT;
  const grid: number[] = [];
  for (let value = step; value <= top; value += step) grid.push(value);
  const shown = hover !== null && (totals[hover] ?? 0) > 0 ? hover : null;
  const left = shown === null ? 0 : ((shown + 0.5) / days) * 100;

  return (
    <div className="px-5 pt-4 pb-3.5">
      <div className="mb-2.5 flex flex-wrap justify-end gap-x-4 gap-y-1 text-xs text-ink-2">
        {series.map((item) => (
          <span key={item.key} className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="size-2.5 rounded-[2px]"
              style={{ background: item.color, opacity: item.opacity }}
            />
            {item.label}
          </span>
        ))}
      </div>
      <div className="relative ml-12" style={{ height: PLOT_HEIGHT }}>
        {grid.map((value) => {
          const y = PLOT_HEIGHT - (value / top) * PLOT_HEIGHT;
          return (
            <Fragment key={value}>
              <div
                aria-hidden
                className="absolute inset-x-0 border-t border-dashed border-border/60"
                style={{ top: y }}
              />
              <span
                aria-hidden
                className="absolute -left-12 w-10 text-right font-mono text-[11px] text-muted-foreground"
                style={{ top: y - 7 }}
              >
                {axisLabel(value)}
              </span>
            </Fragment>
          );
        })}
        <div
          className="absolute inset-0 flex items-end gap-1 border-b"
          onMouseLeave={() => setHover(null)}
          role="img"
          aria-label={`Minutes per day over the last ${days} days`}
        >
          {totals.map((_, day) => (
            <div
              key={day}
              className="flex h-full min-w-0 flex-1 flex-col justify-end gap-px transition-opacity"
              style={{ opacity: shown === null || shown === day ? 1 : 0.45 }}
              onMouseEnter={() => setHover(day)}
            >
              {[...series].reverse().map((item) => {
                const ms = item.dailyMs[day] ?? 0;
                return ms > 0 ? (
                  <div
                    key={item.key}
                    className="rounded-[2px]"
                    style={{
                      height: Math.max(2, height(ms) - 1),
                      background: item.color,
                      opacity: item.opacity,
                    }}
                  />
                ) : null;
              })}
            </div>
          ))}
        </div>
        {shown !== null && (
          <div
            className="pointer-events-none absolute top-0 z-10 mx-3.5 min-w-56 rounded-lg border bg-popover text-sm shadow-xl"
            style={{
              left: `${left}%`,
              transform: left > 55 ? "translateX(calc(-100% - 28px))" : undefined,
            }}
          >
            <div className="flex justify-between gap-3 border-b px-3 py-2 text-ink-2">
              <span>{dayLabel(readAt, days, shown)}</span>
              <span className="font-semibold text-foreground tabular-nums">
                {minutesText(totals[shown] ?? 0)} min
              </span>
            </div>
            <div className="grid gap-1 px-3 py-2">
              {series
                .filter((item) => (item.dailyMs[shown] ?? 0) > 0)
                .map((item) => (
                  <span key={item.key} className="flex justify-between gap-4">
                    <span className="inline-flex min-w-0 items-center gap-1.5">
                      <span
                        aria-hidden
                        className="size-2 shrink-0 rounded-[2px]"
                        style={{ background: item.color, opacity: item.opacity }}
                      />
                      <span className="truncate">{item.label}</span>
                    </span>
                    <span className="font-semibold tabular-nums">
                      {minutesText(item.dailyMs[shown] ?? 0)} min
                    </span>
                  </span>
                ))}
            </div>
          </div>
        )}
      </div>
      <div className="mt-2 ml-12 flex justify-between font-mono text-[11px] text-muted-foreground">
        <span>{dayLabel(readAt, days, 0)}</span>
        <span>{dayLabel(readAt, days, Math.floor((days - 1) / 2))}</span>
        <span>{dayLabel(readAt, days, days - 1)}</span>
      </div>
    </div>
  );
}

function Sparkline({ dailyMs, color }: { dailyMs: number[]; color: string }) {
  const width = 160;
  const height = 30;
  const max = Math.max(...dailyMs);
  if (!max) return <svg aria-hidden width={width} height={height} />;
  const x = (day: number) => 2 + (day / Math.max(1, dailyMs.length - 1)) * (width - 4);
  const y = (ms: number) => height - 3 - (ms / max) * (height - 6);
  const active = dailyMs.filter(Boolean).length;
  return (
    <svg aria-hidden width={width} height={height} className="block">
      {active <= 4 ? (
        dailyMs.map((ms, day) =>
          ms ? <circle key={day} cx={x(day)} cy={y(ms)} r={2} fill={color} /> : null,
        )
      ) : (
        <path
          d={dailyMs.map((ms, day) => `${day ? "L" : "M"}${x(day)},${y(ms)}`).join(" ")}
          fill="none"
          stroke={color}
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

const COLUMNS =
  "grid grid-cols-[minmax(280px,2.3fr)_168px_minmax(150px,1.3fr)_repeat(4,minmax(72px,0.8fr))] items-center gap-3.5";

function Jobs({
  lines,
  readAt,
  days,
  scope,
  onScope,
}: {
  lines: JobLine[];
  readAt: number;
  days: number;
  scope: string | null;
  onScope: (key: string) => void;
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(lines.slice(0, 1).map((l) => l.key)));
  const allOpen = lines.every((line) => open.has(line.key));
  const toggle = (key: string) => {
    const next = new Set(open);
    if (!next.delete(key)) next.add(key);
    setOpen(next);
  };

  return (
    <section aria-label="Jobs" className="grid gap-2">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold">Jobs</h2>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setOpen(allOpen ? new Set() : new Set(lines.map((line) => line.key)))}
        >
          {allOpen ? "Collapse all" : "Expand all"}
        </Button>
      </div>
      <div className="overflow-x-auto rounded-xl border bg-card">
        <div className="min-w-[1000px] text-sm tabular-nums">
          <div className={cn(COLUMNS, "border-b py-3 pr-5 pl-3 text-muted-foreground")}>
            <span className="pl-10">Workflow › job</span>
            <span>Minutes per day</span>
            <span>Where it ran</span>
            <span className="inline-flex items-center justify-end gap-1 text-foreground">
              Minutes
              <ChevronDownIcon aria-hidden className="size-3" />
            </span>
            <span className="text-right">Quota min</span>
            <span className="text-right">Typical run</span>
            <span className="text-right">Runs</span>
          </div>
          {lines.map((line) => {
            const isOpen = open.has(line.key);
            const typical = typicalRun(line.runners);
            const machineShare = line.runMs ? line.byWhere.machine / line.runMs : 0;
            const offQuota = line.runMs ? 1 - line.byWhere.quota / line.runMs : 0;
            const splitText =
              machineShare >= 0.005
                ? `${Math.round(machineShare * 100)}% on your machines`
                : line.workflow.private === false
                  ? "Public repo: no quota"
                  : `${Math.round(offQuota * 100)}% off quota`;
            return (
              <Fragment key={line.key}>
                <div
                  className={cn(
                    COLUMNS,
                    "border-t py-3 pr-5 pl-3 first:border-t-0 hover:bg-secondary/40",
                    scope === line.key && "bg-secondary/70 shadow-[inset_2px_0_0_var(--rr-go)]",
                  )}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      aria-label={`${isOpen ? "Hide" : "Show"} runners for ${line.job.name}`}
                      onClick={() => toggle(line.key)}
                      className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <ChevronRightIcon
                        aria-hidden
                        className={cn("size-4 transition-transform", isOpen && "rotate-90")}
                      />
                    </button>
                    <button
                      type="button"
                      title="Chart this job"
                      aria-pressed={scope === line.key}
                      onClick={() => onScope(line.key)}
                      className="group grid min-w-0 gap-0.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="truncate text-[15px]">
                        <span className="text-muted-foreground">
                          {line.workflow.workflow ?? "Unnamed workflow"} ›{" "}
                        </span>
                        <span className="font-semibold underline-offset-4 group-hover:underline">
                          {line.job.name}
                        </span>
                      </span>
                      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span className="truncate">{line.workflow.repository}</span>
                        {line.workflow.private !== null && (
                          <span className="rounded-full border px-1.5 text-[11px]">
                            {line.workflow.private ? "Private" : "Public"}
                          </span>
                        )}
                      </span>
                    </button>
                  </div>
                  <div className="grid gap-0.5">
                    <Sparkline dailyMs={line.dailyMs} color="var(--rr-ink-2)" />
                    <span className="flex w-40 justify-between font-mono text-[10px] text-muted-foreground">
                      <span>{dayLabel(readAt, days, 0, false)}</span>
                      <span>{dayLabel(readAt, days, days - 1, false)}</span>
                    </span>
                  </div>
                  <div className="grid gap-1.5">
                    <div className="flex h-2 gap-0.5 overflow-hidden rounded-full bg-border">
                      {WHERE_ORDER.filter((where) => line.byWhere[where] > 0).map((where) => (
                        <div
                          key={where}
                          style={{
                            width: `${(line.byWhere[where] / line.runMs) * 100}%`,
                            background: WHERE[where].color,
                            opacity: WHERE[where].opacity,
                          }}
                        />
                      ))}
                    </div>
                    <span className="text-xs text-ink-2">{splitText}</span>
                  </div>
                  <span className="text-right text-[15px] font-semibold">
                    {minutesText(line.runMs)}
                  </span>
                  <QuotaCell lines={line.runners} />
                  <span
                    className={cn(
                      "text-right text-[15px] text-ink-2",
                      typical.few && "text-muted-foreground",
                    )}
                  >
                    {typical.few && typical.ms !== null && "~"}
                    {durationText(typical.ms)}
                  </span>
                  <span className="text-right text-[15px] text-ink-2">
                    {line.runs.toLocaleString()}
                  </span>
                </div>
                {isOpen &&
                  line.runners.map((runner) => (
                    <RunnerRow key={runner.env.key} runner={runner} jobMs={line.runMs} />
                  ))}
              </Fragment>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function QuotaCell({ lines }: { lines: RunnerLine[] }) {
  const quota = lines.reduce((sum, runner) => sum + runner.minutes.quotaMinutes, 0);
  return (
    <span className={cn("text-right text-[15px]", quota ? "text-run" : "text-muted-foreground")}>
      {Math.round(quota).toLocaleString()}
    </span>
  );
}

function RunnerRow({ runner, jobMs }: { runner: RunnerLine; jobMs: number }) {
  const where = WHERE[runner.where];
  const few = !runner.stat || runner.stat.samples < 5;
  const quota =
    runner.where === "quota"
      ? {
          text: Math.round(runner.minutes.quotaMinutes).toLocaleString(),
          className: "text-run",
          title: `${Math.round(runner.minutes.quotaMinutes)} quota minutes for ${minutesText(runner.minutes.runMs)} minutes of work`,
        }
      : runner.where === "free"
        ? {
            text: "free",
            className: "text-muted-foreground",
            title: "Public repos use no GitHub minutes",
          }
        : {
            text: "—",
            className: "text-muted-foreground",
            title:
              runner.where === "machine"
                ? "Your machine: no quota"
                : "Billed by the provider, not GitHub",
          };
  return (
    <div className={cn(COLUMNS, "border-t border-border/50 bg-background/60 py-2.5 pr-5 pl-3")}>
      <div className="flex min-w-0 items-center gap-2.5 pl-12">
        <span
          aria-hidden
          className="size-2.5 shrink-0 rounded-[3px]"
          style={{ background: runner.color }}
        />
        <span className="grid min-w-0 gap-0.5">
          <span className="truncate">{runner.env.label}</span>
          {runner.env.detail && (
            <span className="truncate text-xs text-muted-foreground">{runner.env.detail}</span>
          )}
        </span>
      </div>
      <Sparkline dailyMs={runner.minutes.dailyMs} color={runner.color} />
      <div className="grid gap-1.5">
        <div className="h-2 overflow-hidden rounded-full bg-border">
          <div
            className="h-full rounded-full"
            style={{
              width: `${jobMs ? (runner.minutes.runMs / jobMs) * 100 : 0}%`,
              background: where.color,
              opacity: where.opacity,
            }}
          />
        </div>
        <span className="text-xs text-ink-2">
          <span style={{ color: runner.where === "free" ? undefined : where.color }}>
            {where.label}
          </span>{" "}
          · {percent(runner.minutes.runMs, jobMs)} of this job
        </span>
      </div>
      <span className="text-right font-semibold">{minutesText(runner.minutes.runMs)}</span>
      <span className={cn("text-right", quota.className)} title={quota.title}>
        {quota.text}
      </span>
      <span className={cn("text-right text-ink-2", few && "text-muted-foreground")}>
        {few && runner.stat?.medianMs != null && "~"}
        {durationText(runner.stat?.medianMs ?? null)}
      </span>
      <span className="text-right text-ink-2">{runner.minutes.runs.toLocaleString()}</span>
    </div>
  );
}
