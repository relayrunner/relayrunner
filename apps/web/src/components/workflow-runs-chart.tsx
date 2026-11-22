// Every successful run of one workflow over the window, for its page: a faint dot per run, a line
// through each runner's daily median that breaks where it took no runs for over two days, and
// evaluation runs as rings. Shows the whole workflow or one job, as time or cost per run.
import { useWidth } from "@/components/chart-parts";
import { clock, DAY_MS, niceStep, type WorkflowRunPoint } from "@/lib/job-times";
import { shortDate } from "@/lib/time-zone";

export type ChartSeries = { key: string; name: string; color: string };

/** A day with more than this many empty days before it starts a new line. */
const GAP_DAYS = 2;

const HEIGHT = 300;
const TOP = 12;
const BOTTOM = 26;
const RIGHT = 12;

function median(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** A point's value for the series: the run, or its one job on that runner. */
export function pointsOf(
  runs: WorkflowRunPoint[],
  key: string,
  job: string | null,
  cost: boolean,
): { at: number; value: number; evaluation: boolean; runId: number }[] {
  return runs.flatMap((run) => {
    let ms: number;
    let usd: number | null;
    if (job === null) {
      if (run.environment !== key) return [];
      ({ ms, usd } = run);
    } else {
      const found = run.jobs.find((each) => each.name === job && each.environment === key);
      if (!found) return [];
      ({ ms, usd } = found);
    }
    const value = cost ? usd : ms;
    return value === null
      ? []
      : [{ at: run.at, value, evaluation: run.evaluation, runId: run.runId }];
  });
}

function costStep(max: number) {
  const steps = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10];
  return steps.find((step) => step >= max / 4) ?? 10;
}

const costText = (usd: number) => (usd === 0 ? "$0" : `$${usd.toFixed(usd < 0.01 ? 3 : 2)}`);

export function WorkflowRunsChart({
  runs,
  series,
  job,
  cost,
  from,
  to,
}: {
  runs: WorkflowRunPoint[];
  series: ChartSeries[];
  /** One job's name, or null for the whole workflow. */
  job: string | null;
  cost: boolean;
  from: number;
  to: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const lines = series.map((each) => ({ ...each, points: pointsOf(runs, each.key, job, cost) }));
  const values = lines.flatMap((line) => line.points.map((point) => point.value));
  const max = Math.max(...values, cost ? 0.01 : 60_000) * 1.08;
  const step = cost ? costStep(max) : niceStep(max / 4);
  const yMax = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: Math.round(yMax / step) + 1 }, (_, i) => i * step);
  const format = cost ? costText : clock;
  const left = cost ? 52 : 44;
  const plot = Math.max(width - left - RIGHT, 1);
  const x = (at: number) => left + ((at - from) / (to - from)) * plot;
  const y = (value: number) => TOP + (1 - value / yMax) * (HEIGHT - TOP - BOTTOM);
  const days = Math.max(1, Math.round((to - from) / DAY_MS));
  // About one date every 120px.
  const labels = Math.max(2, Math.min(days + 1, Math.floor(plot / 120)));
  const dates = Array.from({ length: labels }, (_, i) => from + ((to - from) * i) / (labels - 1));

  return (
    <div ref={ref} className="w-full">
      {width > 0 && (
        <svg
          width={width}
          height={HEIGHT}
          role="img"
          aria-label={`${cost ? "Cost" : "Time"} of each successful run over the range, by runner`}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line x1={left} x2={width - RIGHT} y1={y(tick)} y2={y(tick)} stroke="var(--border)" />
              <text
                x={left - 8}
                y={y(tick) + 3.5}
                textAnchor="end"
                className="fill-muted-foreground text-[11px] tabular-nums"
              >
                {format(tick)}
              </text>
            </g>
          ))}
          {dates.map((at, i) => (
            <text
              key={at}
              x={x(at)}
              y={HEIGHT - 6}
              textAnchor={i === 0 ? "start" : i === dates.length - 1 ? "end" : "middle"}
              className="fill-muted-foreground text-[11px]"
            >
              {shortDate(Math.min(at, to - 1))}
            </text>
          ))}
          {lines.map((line) => {
            const routed = line.points.filter((point) => !point.evaluation);
            const evaluations = line.points.filter((point) => point.evaluation);
            const byDay = new Map<number, typeof routed>();
            for (const point of routed) {
              const day = Math.floor((point.at - from) / DAY_MS);
              byDay.set(day, [...(byDay.get(day) ?? []), point]);
            }
            const daily = [...byDay]
              .sort((a, b) => a[0] - b[0])
              .map(([day, points]) => ({ day, value: median(points.map((point) => point.value)) }));
            const segments: (typeof daily)[] = [];
            for (const point of daily) {
              const last = segments.at(-1);
              if (last && point.day - last.at(-1)!.day <= GAP_DAYS + 1) last.push(point);
              else segments.push([point]);
            }
            const dayX = (day: number) => x(Math.min(from + (day + 0.5) * DAY_MS, to));
            return (
              <g key={line.key}>
                {routed.map((point) => (
                  <circle
                    key={`${point.runId}-${point.at}`}
                    cx={x(point.at)}
                    cy={y(point.value)}
                    r={2.5}
                    fill={line.color}
                    fillOpacity={0.3}
                  >
                    <title>{`${line.name} · ${format(point.value)} · ${shortDate(point.at)}`}</title>
                  </circle>
                ))}
                {segments.map((segment) =>
                  segment.length > 1 ? (
                    <polyline
                      key={segment[0]!.day}
                      points={segment
                        .map((point) => `${dayX(point.day)},${y(point.value)}`)
                        .join(" ")}
                      fill="none"
                      stroke={line.color}
                      strokeWidth={2}
                      strokeLinejoin="round"
                    />
                  ) : null,
                )}
                {daily.map((point) => (
                  <circle
                    key={`d${point.day}`}
                    cx={dayX(point.day)}
                    cy={y(point.value)}
                    r={3}
                    fill={line.color}
                  >
                    <title>{`${line.name} · daily median ${format(point.value)}`}</title>
                  </circle>
                ))}
                {evaluations.map((point) => (
                  <circle
                    key={`e${point.runId}-${point.at}`}
                    cx={x(point.at)}
                    cy={y(point.value)}
                    r={4.5}
                    fill="var(--card)"
                    stroke={line.color}
                    strokeWidth={2}
                  >
                    <title>{`${line.name} evaluation · ${format(point.value)}`}</title>
                  </circle>
                ))}
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}
