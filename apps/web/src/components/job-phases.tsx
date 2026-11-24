// Where time goes inside jobs, from the steps GitHub reports: setup (what every run does to get
// the machine ready) against the job's own build, test and other work. Used by the Job types tab
// and the steps of a job's average run in its detail on Performance. Details sit in hover cards so
// the bars carry no clipped labels.
import type { ReactNode } from "react";
import { Count } from "@/components/count";
import { Legend, type Series, Swatch } from "@/components/stacked-bars";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import {
  cachedTotal,
  type Inside,
  insideOfSteps,
  insideTotal,
  isCacheable,
  isSetup,
  SETUP_ORDER,
  type SetupItem,
  setupLabel,
  setupShare,
  setupTotal,
  WORK_ORDER,
  workLabel,
} from "@/lib/job-phases";
import { clock, minutesText, plural, type RunStep } from "@/lib/job-times";
import { typeColor, typeLabel, type TypeSummary } from "@/lib/job-types";
import { percent } from "@/lib/utils";

const HATCH =
  "repeating-linear-gradient(135deg, var(--setup-stripe) 0 2px, var(--setup-ground) 2px 5px)";
const CACHED = "var(--setup-cached)";

type Format = (ms: number) => string;

/** The bar's pieces in stack order: setup without a cache, setup under one, then work. */
function segments(inside: Inside): (Series & { ms: number })[] {
  const cached = cachedTotal(inside);
  return [
    { key: "setup", label: "Setup", ms: setupTotal(inside) - cached, color: HATCH },
    { key: "cached", label: "Setup with a cache step", ms: cached, color: CACHED },
    ...WORK_ORDER.map((work) => ({
      key: work,
      label: workLabel(work),
      ms: inside.work[work] ?? 0,
      color: typeColor(work),
    })),
  ].filter((segment) => segment.ms > 0);
}

/** A setup item's fill and what a cache step says about it (null for setup no cache covers). */
function cacheState(inside: Inside, item: SetupItem) {
  const cached = inside.cache[item] ?? 0;
  const all = inside.setup[item] ?? 0;
  if (cached >= all) return { fill: CACHED, note: "Cache step" };
  if (cached > 0) return { fill: HATCH, note: "Cache step in some jobs" };
  return { fill: HATCH, note: isCacheable(item) ? "No cache we can see" : null };
}

function DetailRow({
  fill,
  label,
  note,
  value,
}: {
  fill: string;
  label: string;
  note?: string | null;
  value: string;
}) {
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-2">
      <Swatch color={fill} className="mt-0.5" />
      <span>
        {label}
        {note && <span className="block text-muted-foreground">{note}</span>}
      </span>
      <span className="text-muted-foreground tabular-nums">{value}</span>
    </div>
  );
}

function DetailGroup({
  title,
  value,
  children,
}: {
  title: string;
  value: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1">
      <p className="flex justify-between gap-3 font-medium">
        {title} <span className="tabular-nums">{value}</span>
      </p>
      {children}
    </div>
  );
}

/** Each setup item and kind of work with its time, for a bar's hover card. */
function InsideDetails({ inside, format }: { inside: Inside; format: Format }) {
  const items = SETUP_ORDER.filter((item) => inside.setup[item]);
  const work = WORK_ORDER.filter((kind) => inside.work[kind]);
  return (
    <div className="grid gap-3 text-xs">
      {items.length > 0 && (
        <DetailGroup title="Setup" value={format(setupTotal(inside))}>
          {items.map((item) => (
            <DetailRow
              key={item}
              {...cacheState(inside, item)}
              label={setupLabel(item)}
              value={format(inside.setup[item]!)}
            />
          ))}
        </DetailGroup>
      )}
      {work.length > 0 && (
        <DetailGroup title="Work" value={format(insideTotal(inside) - setupTotal(inside))}>
          {work.map((kind) => (
            <DetailRow
              key={kind}
              fill={typeColor(kind)}
              label={workLabel(kind)}
              value={format(inside.work[kind]!)}
            />
          ))}
        </DetailGroup>
      )}
      {items.some(isCacheable) && (
        <p className="text-muted-foreground">
          A cache step means a cache is set up, not that it hit. A runner can also cache in ways
          step names don't show.
        </p>
      )}
    </div>
  );
}

/**
 * One bar split into setup and work, `width` of the space (0 to 1), with the details on hover.
 * `label` names it for screen readers.
 */
function InsideBar({
  inside,
  format,
  label,
  width = 1,
}: {
  inside: Inside;
  format: Format;
  label: string;
  width?: number;
}) {
  const pieces = segments(inside);
  const total = insideTotal(inside);
  if (!total) return null;
  return (
    <HoverCard openDelay={150}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          aria-label={`${label}: ${pieces.map((piece) => `${piece.label} ${format(piece.ms)}`).join(", ")}`}
          className="flex h-3 min-w-1 cursor-default gap-0.5 rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          style={{ width: `${Math.max(width, 0.005) * 100}%` }}
        >
          {pieces.map((piece) => (
            <span
              key={piece.key}
              className="h-full min-w-0.5 first:rounded-l last:rounded-r"
              style={{ width: `${(piece.ms / total) * 100}%`, background: piece.color }}
            />
          ))}
        </button>
      </HoverCardTrigger>
      <HoverCardContent className="w-72">
        <InsideDetails inside={inside} format={format} />
      </HoverCardContent>
    </HoverCard>
  );
}

const setupText = (inside: Inside) => {
  const share = setupShare(inside);
  return share === null ? "–" : `${percent(share)} setup`;
};

/** The Job types tab's setup and work, for all jobs and each type, bars in minutes. */
export function TypeInside({ summary }: { summary: TypeSummary }) {
  const types = summary.types.filter((type) => type.stepped);
  const longest = Math.max(...types.map((type) => insideTotal(type.inside)), 1);
  // All jobs on its own scale, then each type against the biggest.
  const rows = [
    { key: "all", label: "All jobs", inside: summary.inside, width: 1, minutes: false },
    ...types.map((type) => ({
      key: type.key,
      label: typeLabel(type.key),
      inside: type.inside,
      width: insideTotal(type.inside) / longest,
      minutes: true,
    })),
  ];

  return (
    <section className="rounded-xl border bg-card p-4 sm:p-5">
      <h2 className="text-sm font-semibold">Setup, build and test</h2>
      <p className="max-w-[62ch] text-sm text-muted-foreground">
        Each step sorted by its name. Setup is what every run does to get the machine ready. Hover a
        bar for what's in it.
      </p>
      {summary.stepped === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          GitHub sends step times when a job finishes, so they show up as new jobs run.
        </p>
      ) : (
        <>
          <ul className="mt-4 grid gap-3">
            {rows.map((row) => (
              <li key={row.key} className="grid gap-1.5">
                <span className="flex items-baseline justify-between gap-3 text-sm">
                  <span className={row.key === "all" ? "font-medium" : undefined}>{row.label}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {row.minutes && `${minutesText(insideTotal(row.inside))} · `}
                    {setupText(row.inside)}
                  </span>
                </span>
                <InsideBar
                  inside={row.inside}
                  format={minutesText}
                  label={row.label}
                  width={row.width}
                />
              </li>
            ))}
          </ul>
          <div className="mt-4">
            <Legend series={segments(summary.inside)} />
          </div>
          {summary.stepped < summary.runs && (
            <p className="mt-3 text-xs text-muted-foreground">
              From <Count value={summary.stepped} /> of <Count value={summary.runs} /> jobs. GitHub
              didn't send steps for the rest.
            </p>
          )}
        </>
      )}
    </section>
  );
}

// Steps shorter than this are folded into a count, so the list shows where time goes.
const QUICK_MS = 1_000;

const stepFill = (step: RunStep) =>
  isSetup(step.part) ? (step.cache ? CACHED : HATCH) : typeColor(step.part);

/** A job's average successful run, step by step, for its detail on Performance. */
export function RunSteps({ steps }: { steps: RunStep[] }) {
  if (steps.length === 0) return null;
  const inside = insideOfSteps(steps);
  const shown = steps.filter((step) => step.ms >= QUICK_MS);
  const quick = steps.length - shown.length;
  const longest = Math.max(...shown.map((step) => step.ms), 1);

  return (
    <section className="grid min-w-0 gap-3 border-t pt-4">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold">Inside an average run</h3>
        <span className="text-sm text-muted-foreground tabular-nums">{setupText(inside)}</span>
      </div>
      <InsideBar inside={inside} format={clock} label="An average run" />
      <Legend series={segments(inside)} />
      <ol className="grid gap-1 text-sm">
        {shown.map((step) => (
          <li
            key={step.name}
            className="grid grid-cols-[auto_minmax(0,1fr)_3.5rem] items-center gap-x-2"
          >
            <Swatch color={stepFill(step)} />
            <span className="relative min-w-0">
              {/* How long it takes next to the longest step, behind its name. */}
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 rounded-sm bg-foreground/[0.07]"
                style={{ width: `${(step.ms / longest) * 100}%` }}
              />
              <span className="relative block truncate px-1.5 py-0.5" title={step.name}>
                {step.name}
              </span>
            </span>
            <span className="text-right text-muted-foreground tabular-nums">{clock(step.ms)}</span>
          </li>
        ))}
      </ol>
      {quick > 0 && (
        <p className="text-xs text-muted-foreground">And {plural(quick, "step")} under a second.</p>
      )}
    </section>
  );
}
