import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Count } from "@/components/count";
import { SectionBoundary } from "@/components/error-boundary";
import { PageHeader } from "@/components/page-header";
import { StatTile } from "@/components/stat-tile";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  getRoutingHealth,
  LONG_WAIT_MS,
  reasonCode,
  reasonText,
  ROUTING_RANGES,
  type RoutingBucket,
  type RoutingHealth,
  type RoutingRange,
  sampleRoutingHealth,
} from "@/lib/admin-routing";
import { authDisabled } from "@/lib/auth-client";
import { cn, elapsed, exact } from "@/lib/utils";

function load(range: RoutingRange): Promise<RoutingHealth> {
  if (authDisabled) return Promise.resolve(sampleRoutingHealth(range));
  return getRoutingHealth(range);
}

// Operator admin, behind Cloudflare Access and an operator session (apps/api/src/routes/admin.ts).
export const Route = createFileRoute("/_authed/_workspace/admin/routing")({
  loader: () => load("24h"),
  component: RoutingPage,
});

const OUTCOMES = [
  { key: "routed", label: "Got a runner", color: "var(--rr-go)" },
  { key: "queued", label: "Queued for a machine", color: "var(--rr-run)" },
  { key: "unroutable", label: "Couldn't route", color: "var(--rr-del)" },
] as const;

const share = (part: number, whole: number) =>
  whole ? `${((part / whole) * 100).toFixed(1).replace(/\.0$/, "")}%` : "0%";

function RoutingPage() {
  const first = Route.useLoaderData();
  const [health, setHealth] = useState(first);
  const [range, setRange] = useState<RoutingRange>(first.range);

  function chooseRange(next: RoutingRange) {
    setRange(next);
    load(next)
      .then(setHealth)
      .catch(() => undefined);
  }

  const { totals } = health;
  const window = range === "24h" ? "last 24 hours" : "last 7 days";

  return (
    <section>
      <PageHeader title="Routing">
        How relays ended across every workspace: whether each job got a runner right away, queued
        for a busy machine, or had nowhere to run. Our own workspaces and test accounts are left
        out.
      </PageHeader>
      <div className="grid max-w-5xl grid-cols-[minmax(0,1fr)] gap-6">
        <div role="group" aria-label="Range" className="flex gap-1.5">
          {ROUTING_RANGES.map(({ value, label }) => (
            <Button
              key={value}
              size="sm"
              variant={range === value ? "secondary" : "ghost"}
              aria-pressed={range === value}
              onClick={() => value !== range && chooseRange(value)}
            >
              {label}
            </Button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <StatTile
            label="Relays"
            value={<Count value={totals.relays} />}
            detail={`in the ${window}`}
          />
          <StatTile
            label="Got a runner right away"
            value={share(totals.routed, totals.relays)}
            detail={`${exact(totals.routed)} relays`}
          />
          <StatTile
            label="Queued for a machine"
            value={<Count value={totals.queued} />}
            detail={`p95 wait ${elapsed(totals.p95WaitMs)}`}
          />
          <StatTile
            label="Couldn't route"
            value={<Count value={totals.unroutable} />}
            detail={`${share(totals.unroutable, totals.relays)} · ${totals.unroutableWorkspaces} ${
              totals.unroutableWorkspaces === 1 ? "workspace" : "workspaces"
            }`}
          />
          <StatTile
            label="Waiting right now"
            value={<Count value={totals.waitingNow} />}
            detail={
              totals.oldestWaitingMs === null
                ? "nothing queued"
                : `oldest ${elapsed(totals.oldestWaitingMs)}`
            }
          />
        </div>

        <SectionBoundary>
          <OutcomeChart health={health} />
        </SectionBoundary>

        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-2">
          <SectionBoundary>
            <Reasons health={health} />
          </SectionBoundary>
          <SectionBoundary>
            <BacklogChart health={health} />
          </SectionBoundary>
        </div>

        <SectionBoundary>
          <Workspaces health={health} />
        </SectionBoundary>
      </div>
    </section>
  );
}

/** "14:00", or "Thu 18:00" for the 7-day range. */
function bucketLabel(start: string, range: RoutingRange) {
  const date = new Date(start);
  const time = date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return range === "24h"
    ? time
    : `${date.toLocaleDateString("en-US", { weekday: "short" })} ${time}`;
}

/** "14:00–15:00", or "Thu 06:00–12:00" for 6-hour buckets. */
function bucketSpan(bucket: RoutingBucket, health: RoutingHealth) {
  const end = new Date(new Date(bucket.start).getTime() + health.bucketMs).toISOString();
  return `${bucketLabel(bucket.start, health.range)}–${bucketLabel(end, "24h")}`;
}

/** The card beside a hovered column, flipped to its left past the middle so it stays inside. */
function ColumnTip({
  index,
  count,
  title,
  rows,
}: {
  index: number;
  count: number;
  title: string;
  rows: { label: string; value: string; color?: string; line?: boolean }[];
}) {
  const center = ((index + 0.5) / count) * 100;
  const right = index >= count / 2;
  return (
    <div
      role="status"
      className="pointer-events-none absolute top-0 z-10 grid min-w-44 gap-0.5 rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-md"
      style={
        right ? { right: `calc(${100 - center}% + 12px)` } : { left: `calc(${center}% + 12px)` }
      }
    >
      <p className="font-medium">{title}</p>
      {rows.map((row) => (
        <p key={row.label} className="flex items-center gap-1.5 text-muted-foreground">
          {row.color && (
            <span
              aria-hidden="true"
              className={cn(
                "shrink-0",
                row.line ? "h-0.5 w-2.5 rounded-full" : "size-2 rounded-sm",
              )}
              style={{ background: row.color }}
            />
          )}
          {row.label}
          <span className="ml-auto pl-3 font-medium text-foreground tabular-nums">{row.value}</span>
        </p>
      ))}
    </div>
  );
}

/** Five evenly spaced labels under a chart of `buckets`. */
/** Times under a chart; a narrow chart gets three so the 7-day labels don't touch. */
function TimeAxis({ health, narrow = false }: { health: RoutingHealth; narrow?: boolean }) {
  const { buckets, range } = health;
  const ticks = (narrow ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1]).map((f) =>
    Math.round(f * (buckets.length - 1)),
  );
  return (
    <div className="mt-2 flex justify-between font-mono text-xs text-muted-foreground tabular-nums">
      {ticks.map((i) => (
        <span key={i}>{bucketLabel(buckets[i]!.start, range)}</span>
      ))}
    </div>
  );
}

/** A round top for an axis that holds `max`, and its ticks from 0. */
function axis(max: number, ticks = 4) {
  if (max <= 0) return { top: 1, ticks: [1, 0] };
  const raw = max / ticks;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw)!;
  const top = Math.ceil(max / step) * step;
  return { top, ticks: Array.from({ length: top / step + 1 }, (_, i) => top - i * step) };
}

function ChartCard({
  title,
  description,
  legend,
  children,
}: {
  title: string;
  description: string;
  legend?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="gap-4 px-5 py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-semibold">{title}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
        </div>
        {legend}
      </div>
      {children}
    </Card>
  );
}

function Swatch({ color, label, line }: { color: string; label: string; line?: boolean }) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span
        aria-hidden="true"
        className={cn(line ? "h-0.5 w-3.5 rounded-full" : "size-2.5 rounded-sm")}
        style={{ background: color }}
      />
      {label}
    </span>
  );
}

function OutcomeChart({ health }: { health: RoutingHealth }) {
  const [hover, setHover] = useState<number | null>(null);
  const hovered = hover === null ? null : health.buckets[hover];
  const totals = health.buckets.map((b) => b.routed + b.queued + b.unroutable);
  const { top, ticks } = axis(Math.max(...totals));
  return (
    <ChartCard
      title={`Jobs per ${health.range === "24h" ? "hour" : "6 hours"}, by outcome`}
      description={
        health.range === "24h"
          ? "Each relay, by the hour it was picked."
          : "Each relay, in 6-hour blocks."
      }
      legend={
        <div className="flex flex-wrap gap-3">
          {OUTCOMES.map((o) => (
            <Swatch key={o.key} color={o.color} label={o.label} />
          ))}
        </div>
      }
    >
      <div>
        <div className="flex gap-2">
          <YAxis ticks={ticks} />
          <div
            role="img"
            aria-label={`Relays per ${health.range === "24h" ? "hour" : "6 hours"} by outcome`}
            className="relative flex h-48 min-w-0 flex-1 items-end gap-[3px] border-b"
            onPointerLeave={() => setHover(null)}
          >
            <GridLines count={ticks.length - 1} />
            {health.buckets.map((bucket, i) => (
              <div
                key={bucket.start}
                onPointerEnter={() => setHover(i)}
                className={cn(
                  "relative flex h-full flex-1 flex-col-reverse",
                  hover === i && "bg-foreground/5",
                )}
              >
                {OUTCOMES.map((o) =>
                  bucket[o.key] > 0 ? (
                    <div
                      key={o.key}
                      style={{ height: `${(bucket[o.key] / top) * 100}%`, background: o.color }}
                    />
                  ) : null,
                )}
              </div>
            ))}
            {hovered && hover !== null && (
              <ColumnTip
                index={hover}
                count={health.buckets.length}
                title={bucketSpan(hovered, health)}
                rows={[
                  ...OUTCOMES.map((o) => ({
                    label: o.label,
                    value: exact(hovered[o.key]),
                    color: o.color,
                  })),
                  {
                    label: "Relays",
                    value: exact(hovered.routed + hovered.queued + hovered.unroutable),
                  },
                ]}
              />
            )}
          </div>
        </div>
        <div className="pl-10">
          <TimeAxis health={health} />
        </div>
      </div>
    </ChartCard>
  );
}

function YAxis({ ticks, format = String }: { ticks: number[]; format?: (n: number) => string }) {
  return (
    <div className="flex h-48 w-8 shrink-0 flex-col justify-between text-right font-mono text-xs text-muted-foreground tabular-nums">
      {ticks.map((t) => (
        <span key={t} className="leading-none">
          {format(t)}
        </span>
      ))}
    </div>
  );
}

function GridLines({ count }: { count: number }) {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex flex-col">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex-1 border-t border-dashed border-border/70" />
      ))}
    </div>
  );
}

function Reasons({ health }: { health: RoutingHealth }) {
  const max = Math.max(1, ...health.reasons.map((r) => r.count));
  return (
    <ChartCard
      title="Why relays couldn't route"
      description="A relay that skipped several steps counts once for each reason."
    >
      {health.reasons.length === 0 ? (
        <p className="text-sm text-muted-foreground">Every relay found a runner.</p>
      ) : (
        <ul className="grid gap-3">
          {health.reasons.map((reason) => (
            <li key={reasonCode(reason)} className="grid gap-1.5">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0">
                  {reasonText(reason)}{" "}
                  <span className="font-mono text-xs text-muted-foreground">
                    {reason.kind === "setup" ? "setup" : reasonCode(reason)}
                  </span>
                </span>
                <span className="tabular-nums">{exact(reason.count)}</span>
              </div>
              <div className="h-2 rounded-full bg-muted">
                <div
                  className="h-2 rounded-full"
                  style={{
                    width: `${(reason.count / max) * 100}%`,
                    background: reason.kind === "setup" ? "var(--rr-mute)" : "var(--rr-del)",
                  }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </ChartCard>
  );
}

const minutesLabel = (ms: number) => `${Math.round(ms / 60_000)}m`;

function BacklogChart({ health }: { health: RoutingHealth }) {
  const left = axis(Math.max(...health.buckets.map((b) => b.peakWaiting)));
  const waits = health.buckets.map((b) => b.p95WaitMs ?? 0);
  const right = axis(Math.max(LONG_WAIT_MS, ...waits) / 60_000);
  const rightTop = right.top * 60_000;
  const [hover, setHover] = useState<number | null>(null);
  const hovered = hover === null ? null : health.buckets[hover];
  return (
    <ChartCard
      title="Backlog and wait time"
      description="Most jobs waiting for a machine at once (bars), and p95 wait to start (dots)."
      legend={
        <div className="flex flex-wrap gap-3">
          <Swatch color="var(--rr-run)" label="Waiting" />
          <Swatch color="var(--foreground)" label="p95 wait" />
          <Swatch color="var(--rr-del)" label="15m" line />
        </div>
      }
    >
      <div>
        <div className="flex gap-2">
          <YAxis ticks={left.ticks} />
          <div
            role="img"
            aria-label="Jobs waiting for a machine and p95 wait over time"
            className="relative flex h-48 min-w-0 flex-1 items-end gap-[3px] border-b"
            onPointerLeave={() => setHover(null)}
          >
            <GridLines count={left.ticks.length - 1} />
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 border-t border-dashed"
              style={{
                bottom: `${(LONG_WAIT_MS / rightTop) * 100}%`,
                borderColor: "var(--rr-del)",
              }}
            />
            {health.buckets.map((bucket, i) => (
              <div
                key={bucket.start}
                onPointerEnter={() => setHover(i)}
                className={cn(
                  "relative flex h-full flex-1 items-end",
                  hover === i && "bg-foreground/5",
                )}
              >
                {bucket.peakWaiting > 0 && (
                  <div
                    className="w-full rounded-t-[2px]"
                    style={{
                      height: `${(bucket.peakWaiting / left.top) * 100}%`,
                      background: "color-mix(in oklab, var(--rr-run) 45%, transparent)",
                      borderTop: "2px solid var(--rr-run)",
                    }}
                  />
                )}
                {bucket.p95WaitMs !== null && (
                  <div
                    className="absolute left-1/2 size-1.5 -translate-x-1/2 translate-y-1/2 rounded-full bg-foreground"
                    style={{ bottom: `${(bucket.p95WaitMs / rightTop) * 100}%` }}
                  />
                )}
              </div>
            ))}
            {hovered && hover !== null && (
              <ColumnTip
                index={hover}
                count={health.buckets.length}
                title={bucketSpan(hovered, health)}
                rows={[
                  {
                    label: "Most waiting at once",
                    value: exact(hovered.peakWaiting),
                    color: "var(--rr-run)",
                  },
                  {
                    label: "p95 wait",
                    value: hovered.p95WaitMs === null ? "—" : elapsed(hovered.p95WaitMs),
                    color: "var(--foreground)",
                  },
                  { label: "Queued", value: exact(hovered.queued) },
                ]}
              />
            )}
          </div>
          <div className="flex h-48 w-8 shrink-0 flex-col justify-between font-mono text-xs text-muted-foreground tabular-nums">
            {right.ticks.map((t) => (
              <span key={t} className="leading-none">
                {minutesLabel(t * 60_000)}
              </span>
            ))}
          </div>
        </div>
        <div className="pr-10 pl-10">
          <TimeAxis health={health} narrow />
        </div>
      </div>
    </ChartCard>
  );
}

function Workspaces({ health }: { health: RoutingHealth }) {
  return (
    <ChartCard
      title="Workspaces to look at"
      description="Workspaces with relays in the range, those with failures first, then the longest waits."
    >
      {health.workspaces.length === 0 ? (
        <p className="text-sm text-muted-foreground">No relays in the range.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr className="border-b">
                <th className="py-2 pr-3 font-medium">Workspace</th>
                <th className="py-2 pr-3 text-right font-medium">Relays</th>
                <th className="py-2 pr-3 text-right font-medium">Couldn't route</th>
                <th className="py-2 pr-3 text-right font-medium">Queued</th>
                <th className="py-2 pr-3 text-right font-medium">p95 wait</th>
                <th className="py-2 font-medium">Top reason</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {health.workspaces.map((w) => (
                <tr key={w.id} className="border-b last:border-0">
                  <td className="py-2.5 pr-3 font-medium">{w.name}</td>
                  <td className="py-2.5 pr-3 text-right">{exact(w.relays)}</td>
                  <td
                    className="py-2.5 pr-3 text-right"
                    style={w.unroutable > 0 ? { color: "var(--rr-del)" } : undefined}
                  >
                    {exact(w.unroutable)}
                  </td>
                  <td className="py-2.5 pr-3 text-right">{exact(w.queued)}</td>
                  <td
                    className="py-2.5 pr-3 text-right"
                    style={
                      w.p95WaitMs !== null && w.p95WaitMs >= LONG_WAIT_MS
                        ? { color: "var(--rr-run)", fontWeight: 600 }
                        : undefined
                    }
                  >
                    {elapsed(w.p95WaitMs)}
                  </td>
                  <td className="py-2.5 text-muted-foreground">
                    {w.topReason ? reasonText(w.topReason) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </ChartCard>
  );
}
