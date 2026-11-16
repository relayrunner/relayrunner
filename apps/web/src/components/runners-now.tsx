import { Link } from "@tanstack/react-router";
import { TriangleAlertIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { RunLink } from "@/components/run-sheet";
import { RunnerLink } from "@/components/runner-link";
import { StatusIcon } from "@/components/status-icon";
import { Card } from "@/components/ui/card";
import { clock } from "@/lib/job-times";
import { type LiveJob, type LiveJobs, runnerCounts, waitReason } from "@/lib/live-jobs";
import { timeAgo } from "@/lib/activity";
import type { Machine } from "@/lib/machines";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

// Rows each list shows before "and N more".
const SHOWN = 5;

/**
 * The top of the Runners page: how many jobs are running (on any runner, cloud ones too) and how
 * many of the workspace's own runners they keep busy, how many are idle or offline, how many jobs
 * are queued, and the jobs running and waiting right now, with why each is waiting.
 */
export function RunnersNow({
  machines,
  live,
  updatedAt,
  attention,
}: {
  machines: Machine[];
  live: LiveJobs;
  /** When the page last heard back about its runners (epoch ms), for the freshness line. */
  updatedAt: number;
  /** The Needs attention list, beside the strip when there's anything in it. */
  attention?: ReactNode;
}) {
  const counts = runnerCounts(machines);
  const { running, queued } = live;
  const envs = new Map(live.environments.map((env) => [env.key, env]));
  const longest = queued[0]?.queuedAt;
  const stale = useStale(updatedAt);
  return (
    <section aria-label="Right now" className="grid gap-6">
      <div className="grid gap-2">
        <Freshness
          updatedAt={updatedAt}
          githubAt={githubCheckedAt(machines)}
          githubDown={machines.some((machine) => machine.github?.unreachable)}
          stale={stale}
        />
        <Card
          className={cn(
            "grid grid-cols-2 gap-0 divide-line-soft overflow-hidden py-0 transition-colors sm:grid-cols-4 sm:divide-x",
            stale && "text-muted-foreground",
          )}
        >
          <Tile
            label="Running jobs"
            value={running.length}
            detail={`${counts.running} of ${counts.total} ${counts.total === 1 ? "runner" : "runners"} busy`}
          >
            <div aria-hidden className="mt-2 flex h-1 overflow-hidden rounded-full bg-well">
              <span className="bg-run" style={{ width: share(counts.running, counts.total) }} />
              <span className="bg-go" style={{ width: share(counts.idle, counts.total) }} />
            </div>
          </Tile>
          <Tile
            label="Idle"
            value={counts.idle}
            detail={counts.paused ? `ready for jobs · ${counts.paused} paused` : "ready for jobs"}
          />
          <Tile label="Offline" value={counts.offline} detail="not connected" />
          <Tile
            label="Queued jobs"
            value={queued.length}
            detail={
              longest ? (
                <>
                  longest waiting <Clock from={longest} />
                </>
              ) : (
                "nothing waiting"
              )
            }
          />
        </Card>
      </div>
      {attention}
      <div className={cn("grid gap-6 transition-opacity lg:grid-cols-2", stale && "opacity-60")}>
        <JobList title="Running now" count={running.length} empty="No jobs are running.">
          {running.slice(0, SHOWN).map((job) => (
            <JobRow
              key={job.id}
              job={job}
              from={job.startedAt!}
              detail={
                <>
                  <span className="truncate">{job.repository}</span>
                  <span aria-hidden>·</span>
                  <RunnerLink
                    runner={envs.get(job.environment)!}
                    className="inline-flex min-w-0 items-center gap-1 truncate"
                    markClassName="size-3.5"
                  />
                </>
              }
            />
          ))}
          <More count={running.length - SHOWN} />
        </JobList>
        <JobList title="Queued" count={queued.length} empty="Nothing is waiting for a runner.">
          {queued.slice(0, SHOWN).map((job) => {
            const reason = waitReason(job, envs.get(job.environment), machines);
            return (
              <JobRow
                key={job.id}
                job={job}
                from={job.queuedAt}
                detail={
                  <>
                    <span
                      className={cn(
                        "flex min-w-0 items-center gap-1",
                        reason.problem && "text-run",
                      )}
                    >
                      {reason.problem && (
                        <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
                      )}
                      <span className="truncate">{reason.text}</span>
                    </span>
                    <span aria-hidden>·</span>
                    <span className="truncate">{job.repository}</span>
                  </>
                }
              />
            );
          })}
          <More count={queued.length - SHOWN} />
        </JobList>
      </div>
    </section>
  );
}

// When GitHub was last asked about the runners added from it: the oldest check, since that's how
// stale the page could be. Null when there are none, or none answered.
function githubCheckedAt(machines: Machine[]) {
  const checks = machines.flatMap((machine) =>
    !machine.revokedAt && machine.github?.checkedAt ? [machine.github.checkedAt] : [],
  );
  return checks.length ? Math.min(...checks) : null;
}

// How long the page's numbers stay current without hearing back: two missed refreshes. Past it they
// grey out, since the page may be idle, hidden, or failing to reach the API.
const STALE_MS = 40_000;

/** Whether `updatedAt` is older than STALE_MS, flipping when it gets there with no ticking. */
function useStale(updatedAt: number) {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    const left = updatedAt + STALE_MS - Date.now();
    setStale(left <= 0);
    if (left <= 0) return;
    const timer = setTimeout(() => setStale(true), left);
    return () => clearTimeout(timer);
  }, [updatedAt]);
  return stale;
}

// "Updated 8s ago · GitHub checked 20s ago", ticking each second on its own.
function Freshness({
  updatedAt,
  githubAt,
  githubDown,
  stale,
}: {
  updatedAt: number;
  githubAt: number | null;
  githubDown: boolean;
  stale: boolean;
}) {
  const now = useNow(true);
  return (
    <p
      className={cn(
        "flex flex-wrap justify-end gap-x-1.5 text-xs text-muted-foreground tabular-nums",
        stale && "text-run",
      )}
    >
      <span>Updated {timeAgo(updatedAt, now)}</span>
      {githubDown ? (
        <span>· Couldn't reach GitHub</span>
      ) : (
        githubAt !== null && <span>· GitHub checked {timeAgo(githubAt, now)}</span>
      )}
    </p>
  );
}

const share = (part: number, total: number) => `${total ? (part / total) * 100 : 0}%`;

function Tile({
  label,
  value,
  detail,
  children,
}: {
  label: string;
  value: ReactNode;
  detail: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="min-w-0 px-4 py-3 [&:nth-child(-n+2)]:border-b sm:[&:nth-child(-n+2)]:border-b-0">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      <div className="mt-0.5 truncate text-xs text-muted-foreground">{detail}</div>
      {children}
    </div>
  );
}

function JobList({
  title,
  count,
  empty,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="grid content-start gap-3">
      <h2 className="flex items-baseline gap-2 text-sm font-semibold">
        {title}
        <span className="font-normal text-muted-foreground tabular-nums">{count}</span>
      </h2>
      <Card className="gap-0 divide-y divide-line-soft overflow-hidden py-0">
        {count ? children : <p className="px-4 py-3 text-sm text-muted-foreground">{empty}</p>}
      </Card>
    </section>
  );
}

// A job as GitHub names it ("workflow / job"), a line under it, and a ticking timer. The name opens
// the job in History's run panel.
function JobRow({ job, from, detail }: { job: LiveJob; from: number | null; detail: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-3 px-4 py-2.5">
      <StatusIcon status={job.startedAt === null ? "queued" : "in_progress"} conclusion={null} />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <RunLink
          run={job}
          job={job.id}
          className="truncate text-sm hover:underline hover:underline-offset-2"
        >
          <span className="text-muted-foreground">{job.workflow ?? "Workflow"} / </span>
          {job.name}
        </RunLink>
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {detail}
        </div>
      </div>
      {from !== null && (
        <span className="shrink-0 text-sm text-muted-foreground tabular-nums">
          <Clock from={from} />
        </span>
      )}
    </div>
  );
}

// Time since `from`, ticking each second. Its own component, so only the timer re-renders.
function Clock({ from }: { from: number }) {
  return clock(useNow(true) - from);
}

// The rest are in History, which lists runs still going first.
function More({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <Link to="/history" className="block px-4 py-2.5 text-xs text-muted-foreground hover:underline">
      and {count} more in History
    </Link>
  );
}
