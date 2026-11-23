import {
  type CatalogRow,
  type CatalogRunner,
  runnerPlatform,
  runnerSize,
  sizeText,
} from "@relayrunner/providers";
import { minuteText } from "@relayrunner/providers/runner-table";
import { useState } from "react";
import { ChartTip, TipRow, useWidth } from "@/components/chart-parts";
import { OptionPicker } from "@/components/range-picker";
import { Swatch } from "@/components/stacked-bars";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { plural } from "@/lib/job-times";
import { PRICE_VIEWS, type PriceView, type ProviderRunner } from "@/lib/providers";
import { cn, count } from "@/lib/utils";

// Every runner a provider sells (the catalog in @relayrunner/providers), as a grid of systems by
// vCPUs, or as a chart of price against vCPUs, one line per system. Runners the workspace's jobs
// ran on are marked.

// One colour per system, the same in both views' legends.
const PLATFORM_COLORS: Record<CatalogRow["platform"], string> = {
  linux: "var(--job-test)",
  arm: "var(--job-lint)",
  windows: "var(--job-build)",
  "windows-arm": "var(--job-other)",
  macos: "var(--rr-ink-2)",
  gpu: "var(--job-deploy)",
};

const priceText = (usd: number | null) => (usd === null ? "—" : minuteText(usd));

/** "4 vCPU · 16 GB · Intel · $0.077 a minute". */
const runnerDetail = (cell: Cell) =>
  [sizeText(cell.size), cell.note, `${priceText(cell.usd)} a minute`].filter(Boolean).join(" · ");

// Runners are matched to jobs by system and size: a job's label can name another image of the
// same runner (blacksmith-4vcpu-ubuntu-2204 is the catalog's -2404 at the same price). GitHub's
// runners already go by the rate the catalog lists.
function matchKey(provider: string, label: string) {
  if (provider === "github") return label;
  const vcpus = runnerSize(provider, label)?.vcpus;
  return vcpus ? `${runnerPlatform(provider, label)}:${vcpus}` : label;
}

/** Jobs the workspace ran on each catalog runner, by matchKey. */
function jobsByKey(provider: string, runners: ProviderRunner[]) {
  const jobs = new Map<string, number>();
  for (const runner of runners) {
    const key = matchKey(provider, runner.key.slice(runner.key.indexOf(":") + 1));
    jobs.set(key, (jobs.get(key) ?? 0) + runner.jobs);
  }
  return jobs;
}

interface Cell extends CatalogRunner {
  jobs: number;
}

/** The catalog with each runner's jobs, and the vCPU columns the grid shows. */
function layout(provider: string, catalog: CatalogRow[], runners: ProviderRunner[]) {
  const jobs = jobsByKey(provider, runners);
  const rows = catalog.map((row) => ({
    ...row,
    cells: row.runners.map((runner): Cell => ({
      ...runner,
      jobs: jobs.get(matchKey(provider, runner.label)) ?? 0,
    })),
  }));
  // macOS comes in a machine or two, not a vCPU ladder: when its sizes aren't columns the other
  // rows have, it fills columns in order instead.
  const ladders = rows.filter((row) => row.platform !== "macos");
  const columns = [
    ...new Set(
      (ladders.length ? ladders : rows).flatMap((row) =>
        row.cells.flatMap((cell) => (cell.size ? [cell.size.vcpus] : [])),
      ),
    ),
  ].sort((a, b) => a - b);
  const prices = rows.flatMap((row) => row.cells.flatMap((cell) => (cell.usd ? [cell.usd] : [])));
  return {
    rows,
    columns,
    low: Math.min(...prices),
    high: Math.max(...prices),
  };
}

/** Where each of a row's runners goes in the grid, by column. */
function placed(cells: Cell[], columns: number[]) {
  const slots: (Cell | null)[] = columns.map(() => null);
  const sizes = cells.map((cell) => cell.size?.vcpus);
  const bySize =
    new Set(sizes).size === cells.length && sizes.every((n) => n && columns.includes(n));
  cells.forEach((cell, i) => {
    const at = bySize ? columns.indexOf(cell.size!.vcpus) : i;
    if (at < slots.length && !slots[at]) slots[at] = cell;
  });
  return { slots, bySize };
}

/** The provider's runners and their prices, as a grid or a chart. Null when it lists none. */
export function MachinePrices({
  provider,
  catalog,
  runners,
  view,
  onView,
}: {
  provider: string;
  catalog: CatalogRow[];
  runners: ProviderRunner[];
  view: PriceView;
  onView: (view: PriceView) => void;
}) {
  if (catalog.length === 0) return null;
  const shown = layout(provider, catalog, runners);
  const hasLarger = catalog.some((row) => row.runners.some((runner) => runner.larger));
  const used = shown.rows.some((row) => row.cells.some((cell) => cell.jobs > 0));
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-semibold">Machine prices</h2>
        <OptionPicker label="Show prices as" options={PRICE_VIEWS} value={view} onChange={onView} />
      </div>
      {view === "chart" ? <PriceChart {...shown} /> : <PriceGrid {...shown} />}
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          {view === "chart"
            ? "Price a minute against vCPUs. Both scales double each step."
            : "Price a minute. Darker costs more."}
        </span>
        {hasLarger && (
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden
              className={cn(
                "size-2.5 shrink-0 border-current",
                view === "chart" ? "rounded-full border-2" : "rounded-[3px] border border-dashed",
              )}
            />
            Larger runners, for Team and Enterprise plans. Not free in public repos.
          </span>
        )}
        {used && (
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden
              className={cn(
                "shrink-0 rounded-full",
                view === "chart" ? "size-2.5 border border-foreground" : "size-1.5 bg-foreground",
              )}
            />
            Your jobs ran here
          </span>
        )}
      </p>
    </div>
  );
}

type Shown = ReturnType<typeof layout>;

/** Systems down the side, vCPUs across the top, each runner's price in its cell. */
function PriceGrid({ rows, columns, low, high }: Shown) {
  const shade = (usd: number) =>
    high > low ? 8 + (40 * Math.log(usd / low)) / Math.log(high / low) : 20;
  const template = { gridTemplateColumns: `8.5rem repeat(${columns.length}, minmax(4.5rem, 1fr))` };
  return (
    <TooltipProvider>
      <div className="overflow-x-auto rounded-xl border bg-card p-3 sm:p-4">
        <div className="grid min-w-fit gap-1.5" style={template}>
          <span className="sticky left-0 z-10 bg-card text-xs text-muted-foreground">vCPUs</span>
          {columns.map((vcpus) => (
            <span key={vcpus} className="text-center text-xs text-muted-foreground tabular-nums">
              {vcpus}
            </span>
          ))}
          {rows.map((row) => {
            const { slots, bySize } = placed(row.cells, columns);
            return (
              <div key={row.name} className="contents">
                <span className="sticky left-0 z-10 flex items-center gap-2 bg-card pr-2 text-sm">
                  <span
                    aria-hidden
                    className="size-2 shrink-0 rounded-full"
                    style={{ background: PLATFORM_COLORS[row.platform] }}
                  />
                  {row.name}
                </span>
                {slots.map((cell, i) =>
                  cell ? (
                    <GridCell
                      key={cell.label}
                      cell={cell}
                      tint={cell.usd ? shade(cell.usd) : 0}
                      showSize={!bySize}
                    />
                  ) : (
                    <span key={i} aria-hidden />
                  ),
                )}
              </div>
            );
          })}
        </div>
      </div>
    </TooltipProvider>
  );
}

function GridCell({ cell, tint, showSize }: { cell: Cell; tint: number; showSize: boolean }) {
  const sub = showSize
    ? [cell.size && `${cell.size.vcpus} vCPU`, cell.note].filter(Boolean).join(" · ")
    : cell.note;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            "relative grid min-h-14 content-between gap-1 rounded-lg border px-2.5 py-2 text-left",
            cell.larger && "border-dashed",
          )}
          style={{
            background: `color-mix(in oklab, var(--job-test) ${tint}%, transparent)`,
          }}
        >
          <span className="text-sm font-medium tabular-nums">{priceText(cell.usd)}</span>
          {(cell.jobs > 0 || sub) && (
            <span className="text-xs leading-tight text-muted-foreground">
              {cell.jobs > 0 ? plural(cell.jobs, "job") : sub}
            </span>
          )}
          {cell.jobs > 0 && (
            <span
              aria-hidden
              className="absolute top-2 right-2 size-1.5 rounded-full bg-foreground"
            />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        <RunnerTip cell={cell} />
      </TooltipContent>
    </Tooltip>
  );
}

function RunnerTip({ cell }: { cell: Cell }) {
  return (
    <span className="grid gap-0.5">
      <span className={cn(cell.name && "font-mono")}>
        {cell.name ?? "Larger runner, named by your org"}
      </span>
      <span className="text-muted-foreground">{runnerDetail(cell)}</span>
      {cell.jobs > 0 && (
        <span className="text-muted-foreground">{plural(cell.jobs, "job")} in this range</span>
      )}
    </span>
  );
}

// The chart's drawing area, in SVG units.
const W = 720;
const H = 300;
const PAD = { left: 52, right: 104, top: 12, bottom: 28 };

// How near the pointer has to come to a dot, in screen pixels, for its tooltip to show.
const REACH = 32;

/** Price against vCPUs on doubling scales, a line per system and a dot per runner. */
function PriceChart({ rows, low, high }: Shown) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<string | null>(null);
  const sized = rows.map((row) => {
    const points = row.cells
      .filter((cell): cell is Cell & { usd: number; size: NonNullable<Cell["size"]> } =>
        Boolean(cell.usd && cell.size),
      )
      .sort((a, b) => a.size.vcpus - b.size.vcpus);
    // A line joins a row's runners only when they climb in size and price; macOS's machines and
    // GitHub's two GPU runners stay dots.
    const ladder =
      points.length > 1 &&
      points.every(
        (p, i) =>
          i === 0 || (p.size.vcpus > points[i - 1]!.size.vcpus && p.usd >= points[i - 1]!.usd),
      );
    return { ...row, points, ladder };
  });
  const vcpus = sized.flatMap((row) => row.points.map((p) => p.size.vcpus));
  const minX = Math.min(...vcpus);
  const maxX = Math.max(...vcpus, minX * 2);
  const x = (n: number) =>
    PAD.left + (Math.log(n / minX) / Math.log(maxX / minX)) * (W - PAD.left - PAD.right);
  const top = Math.max(high, low * 2);
  const y = (usd: number) =>
    H - PAD.bottom - (Math.log(usd / low) / Math.log(top / low)) * (H - PAD.top - PAD.bottom);
  const xTicks = doublings(minX, maxX);
  const yTicks = priceTicks(low, top);
  // Lines are named at their ends; rows that are only dots get a legend under the chart.
  const labelY = spreadLabels(
    sized.map((row) => (row.ladder ? y(row.points.at(-1)!.usd) + 4 : -Infinity)),
  );
  const others = sized.filter((row) => row.points.length && !row.ladder);
  const dots = sized.flatMap((row) =>
    row.points.map((cell) => ({
      key: `${row.name}|${cell.label}`,
      cell,
      system: row.name,
      color: PLATFORM_COLORS[row.platform],
      cx: x(cell.size.vcpus),
      cy: y(cell.usd),
    })),
  );
  const hovered = dots.find((dot) => dot.key === hover);
  // The SVG scales to the card's width; the tooltip is placed in pixels.
  const scale = width / W;
  return (
    <div className="grid gap-2 rounded-xl border bg-card p-3 sm:p-4">
      <div ref={ref} className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="block w-full"
          role="img"
          aria-label="Price a minute against vCPUs, one line per system"
          // The nearest dot answers, so the pointer doesn't have to land on one.
          onPointerMove={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            const px = ((event.clientX - box.left) / box.width) * W;
            const py = ((event.clientY - box.top) / box.height) * H;
            let best: (typeof dots)[number] | undefined;
            let bestDistance = Infinity;
            for (const dot of dots) {
              const distance = Math.hypot(dot.cx - px, dot.cy - py);
              if (distance < bestDistance) [best, bestDistance] = [dot, distance];
            }
            setHover(best && bestDistance * (box.width / W) <= REACH ? best.key : null);
          }}
          onPointerLeave={(event) => event.pointerType !== "touch" && setHover(null)}
        >
          {xTicks.map((n) => (
            <g key={`x${n}`}>
              <line
                x1={x(n)}
                x2={x(n)}
                y1={PAD.top}
                y2={H - PAD.bottom}
                className="stroke-border"
              />
              <text
                x={x(n)}
                y={H - 8}
                textAnchor="middle"
                className="fill-muted-foreground text-[11px] tabular-nums"
              >
                {n}
              </text>
            </g>
          ))}
          {yTicks.map((usd) => (
            <g key={`y${usd}`}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={y(usd)}
                y2={y(usd)}
                className="stroke-border"
              />
              <text
                x={PAD.left - 8}
                y={y(usd) + 4}
                textAnchor="end"
                className="fill-muted-foreground text-[11px] tabular-nums"
              >
                ${usd}
              </text>
            </g>
          ))}
          {sized.map((row, r) => {
            const color = PLATFORM_COLORS[row.platform];
            const last = row.points.at(-1);
            return (
              <g key={row.name}>
                {row.ladder && (
                  <polyline
                    fill="none"
                    stroke={color}
                    strokeWidth={2}
                    points={row.points.map((p) => `${x(p.size.vcpus)},${y(p.usd)}`).join(" ")}
                  />
                )}
                {row.points.map((p) => (
                  <g key={p.label}>
                    <circle
                      cx={x(p.size.vcpus)}
                      cy={y(p.usd)}
                      r={p.larger ? 3.5 : 4}
                      fill={p.larger ? "var(--card)" : color}
                      stroke={color}
                      strokeWidth={2}
                    />
                    {p.jobs > 0 && (
                      <circle
                        cx={x(p.size.vcpus)}
                        cy={y(p.usd)}
                        r={8}
                        fill="none"
                        className="stroke-foreground"
                        strokeWidth={1.5}
                      />
                    )}
                  </g>
                ))}
                {last && row.ladder && (
                  <text
                    x={x(last.size.vcpus) + 10}
                    y={labelY[r]}
                    fill={color}
                    className="text-[11px] font-medium"
                  >
                    {row.name}
                  </text>
                )}
              </g>
            );
          })}
          {hovered && (
            <circle
              cx={hovered.cx}
              cy={hovered.cy}
              r={10}
              fill={hovered.color}
              fillOpacity={0.25}
              className="pointer-events-none"
            />
          )}
        </svg>
        {hovered && width > 0 && (
          <ChartTip x={hovered.cx * scale} y={hovered.cy * scale} width={width}>
            <DotTip cell={hovered.cell} system={hovered.system} color={hovered.color} />
          </ChartTip>
        )}
      </div>
      {others.length > 0 && (
        <p className="flex flex-wrap gap-x-4 text-xs text-muted-foreground">
          {others.map((row) => (
            <span key={row.name} className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="size-2 rounded-full"
                style={{ background: PLATFORM_COLORS[row.platform] }}
              />
              {row.name}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

/** A chart dot's runner: its name, system, size, price and the workspace's jobs on it. */
function DotTip({ cell, system, color }: { cell: Cell; system: string; color: string }) {
  return (
    <>
      <p className={cn("font-medium", cell.name && "font-mono")}>
        {cell.name ?? "Larger runner, named by your org"}
      </p>
      <p className="flex items-center gap-1.5 text-muted-foreground">
        <Swatch color={color} className="size-2" />
        {[system, cell.name && cell.larger && "Larger runner", cell.note]
          .filter(Boolean)
          .join(" · ")}
      </p>
      <TipRow label="Price a minute" value={priceText(cell.usd)} />
      {cell.size && <TipRow label="vCPUs" value={String(cell.size.vcpus)} />}
      {cell.size?.memoryGb && <TipRow label="Memory" value={`${cell.size.memoryGb} GB`} />}
      {cell.jobs > 0 && <TipRow label="Your jobs" value={count(cell.jobs)} />}
    </>
  );
}

/** Label heights moved apart so no two lines' names overlap, each kept as near its line as it can. */
function spreadLabels(ys: number[], gap = 13) {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  for (let k = 1; k < order.length; k++) order[k]!.y = Math.max(order[k]!.y, order[k - 1]!.y + gap);
  const out = [...ys];
  for (const { y, i } of order) out[i] = y;
  return out;
}

/** 1, 2, 4 … up to `max`, and `max` itself when it isn't a doubling (96). */
function doublings(min: number, max: number) {
  const ticks: number[] = [];
  for (let n = min; n <= max; n *= 2) ticks.push(n);
  if (ticks.at(-1) !== max) ticks.push(max);
  return ticks;
}

/** Round prices between `low` and `high`: $0.001, $0.002, $0.005, $0.01 … */
function priceTicks(low: number, high: number) {
  const ticks: number[] = [];
  for (let decade = 0.0001; decade < 10; decade *= 10)
    for (const step of [1, 2, 5]) {
      const usd = Number((decade * step).toPrecision(1));
      if (usd >= low * 0.9 && usd <= high * 1.1) ticks.push(usd);
    }
  return ticks;
}
