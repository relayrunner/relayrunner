import { Link, useNavigate } from "@tanstack/react-router";
import {
  ChevronRightIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleSlashIcon,
  CircleXIcon,
  ExternalLinkIcon,
  LoaderCircleIcon,
  type LucideIcon,
  TimerOffIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { ProviderLink } from "@/components/provider-link";
import { providerOf } from "@/components/providers";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { timeAgo } from "@/lib/activity";
import { authDisabled } from "@/lib/auth-client";
import { useLiveRefresh } from "@/lib/live-refresh";
import {
  getJobSteps,
  getRunJobs,
  isFailure,
  type JobStep,
  jobUrl,
  LONG_WAIT_MS,
  type Run,
  type RunHeader,
  type RunIds,
  type RunJob,
  type RunJobs,
  runParam,
  type RunStatus,
  sampleJobSteps,
  sampleRunJobs,
  triggerText,
} from "@/lib/runs";
import { cn, elapsed } from "@/lib/utils";

// While a run is going, how often an open run's jobs and a running job's steps are refetched.
// Paused while the tab is hidden or idle (lib/live-refresh.ts).
const REFRESH_MS = 5_000;

/** Each environment's name, by key. */
export type Environments = Map<string, string>;

export const isLongWait = (wait: number | null): wait is number =>
  wait !== null && wait >= LONG_WAIT_MS;

/** The time now, ticking every second while `enabled`. */
export function useNow(enabled: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

type Status = { Icon: LucideIcon; label: string; className: string };
const CANCELLED: Status = {
  Icon: CircleSlashIcon,
  label: "Cancelled",
  className: "text-muted-foreground",
};
const LIVE = {
  in_progress: { Icon: LoaderCircleIcon, label: "In progress", className: "animate-spin text-run" },
  queued: { Icon: CircleDashedIcon, label: "Queued", className: "text-muted-foreground" },
} satisfies Record<string, Status>;
const STATUS: Record<string, Status> = {
  ...LIVE,
  success: { Icon: CircleCheckIcon, label: "Succeeded", className: "text-go" },
  failure: { Icon: CircleXIcon, label: "Failed", className: "text-destructive" },
  timed_out: { Icon: TimerOffIcon, label: "Timed out", className: "text-destructive" },
  cancelled: CANCELLED,
  skipped: { ...CANCELLED, label: "Skipped" },
};

/** A run's, job's or step's result as an icon: a tick, a cross, a spinner while it runs. */
export function StatusIcon({
  status,
  conclusion,
  className,
}: {
  status: string;
  conclusion: string | null;
  className?: string;
}) {
  const shown = STATUS[status === "completed" ? (conclusion ?? "") : status] ?? {
    ...CANCELLED,
    label: conclusion ?? "Finished",
  };
  return (
    <shown.Icon
      role="img"
      aria-label={shown.label}
      className={cn("size-[18px] shrink-0", shown.className, className)}
    />
  );
}

// The last jobs fetched for the most recent runs, so a run opens with its jobs already there when
// it was hovered first or opened before.
type JobsEntry = { status: RunStatus; at: number; request: Promise<RunJobs>; jobs?: RunJobs };
const jobsCache = new Map<string, JobsEntry>();
const CACHE_SIZE = 50;

/**
 * A run's jobs, from the cache unless the run's status has changed since or, for a run still
 * going, the cached answer is older than a refresh. `fresh` always asks again.
 */
export function fetchRunJobs(run: RunIds, status: RunStatus, fresh = false) {
  const key = runParam(run);
  const cached = jobsCache.get(key);
  const current =
    cached?.status === status && (status === "completed" || Date.now() - cached.at < REFRESH_MS);
  if (cached && current && !fresh) return cached.request;
  const request = authDisabled ? Promise.resolve(sampleRunJobs(run)) : getRunJobs(run);
  const entry: JobsEntry = { status, at: Date.now(), request };
  request.then(
    (jobs) => (entry.jobs = jobs),
    () => jobsCache.get(key) === entry && jobsCache.delete(key),
  );
  jobsCache.delete(key); // Re-added last, so the oldest run is first to go.
  jobsCache.set(key, entry);
  if (jobsCache.size > CACHE_SIZE) jobsCache.delete(jobsCache.keys().next().value!);
  return request;
}

function cachedJobs(run: RunIds, status: RunStatus) {
  const cached = jobsCache.get(runParam(run));
  return (cached?.status === status && cached.jobs) || null;
}

// A finished job's steps don't change, so they're kept once read.
const stepsCache = new Map<number, JobStep[] | null>();

// A job still queued has waited until now, and one still running has run until now.
function waitOf(job: RunJob, now: number) {
  if (job.queuedAt === null) return null;
  const end = job.startedAt ?? (job.status === "queued" ? now : null);
  return end === null ? null : end - job.queuedAt;
}
const ranOf = (job: RunJob, now: number) =>
  job.startedAt === null ? null : (job.completedAt ?? now) - job.startedAt;

/** A run's status and result worked out from its jobs, for a run the list hasn't loaded. */
function outcomeOf(jobs: RunJob[]): { status: RunStatus; conclusion: string | null } {
  if (jobs.some((job) => job.status !== "completed"))
    return { status: "in_progress", conclusion: null };
  const conclusions = jobs.map((job) => job.conclusion);
  const conclusion = ["failure", "timed_out", "cancelled"].find((each) =>
    conclusions.includes(each),
  );
  return { status: "completed", conclusion: conclusion ?? "success" };
}

/**
 * History's detail panel: one run attempt and its jobs, or with `jobId` one of those jobs and its
 * steps. Which one is open lives in the URL (`?run=` and `?job=`), so it can be linked to and the
 * back button steps out of it. `run` is the run from the list, when the list has it.
 */
export function RunSheet({
  ids,
  jobId,
  run,
  environments,
}: {
  ids: RunIds;
  jobId: number | undefined;
  run: Run | undefined;
  environments: Environments;
}) {
  const navigate = useNavigate();
  const close = () =>
    void navigate({ from: "/history", to: "/history", search: (prev) => ({ view: prev.view }) });

  // The run's status from the list when it has the run, else from its jobs once they load.
  const [detail, setDetail] = useState<RunJobs | null>(() =>
    cachedJobs(ids, run?.status ?? "completed"),
  );
  const [failed, setFailed] = useState(false);
  const outcome = detail ? outcomeOf(detail.jobs) : null;
  const status = run?.status ?? outcome?.status ?? "completed";
  const running = status !== "completed";
  const { repositoryId, runId, runAttempt } = ids;
  const key = useMemo(
    () => ({ repositoryId, runId, runAttempt }),
    [repositoryId, runId, runAttempt],
  );
  useEffect(() => {
    let live = true;
    setFailed(false);
    fetchRunJobs(key, run?.status ?? "completed")
      .then((value) => live && setDetail(value))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [key, run?.status]);
  useLiveRefresh(
    () =>
      fetchRunJobs(key, status, true)
        .then(setDetail)
        .catch(() => undefined), // Keep showing the last answer; the next tick retries.
    { intervalMs: REFRESH_MS, enabled: running && !authDisabled },
  );
  // Times of jobs still going run to now. Once the run has finished they stop where it did, so a
  // job GitHub never said finished (a lost webhook) doesn't keep counting.
  const ticking = useNow(
    running && Boolean(detail?.jobs.some((job) => job.status !== "completed")),
  );
  const ended = detail ? Math.max(0, ...detail.jobs.map((job) => job.completedAt ?? 0)) : 0;
  const now = running ? ticking : (run?.updatedAt ?? ended);

  // A runner's name from the page's environments first, then the detail's own.
  const own = new Map(detail?.environments.map((env) => [env.key, env.label]));
  const label = (envKey: string) => environments.get(envKey) ?? own.get(envKey) ?? envKey;
  const header: RunHeader | null = run ?? detail?.run ?? null;
  const job = jobId === undefined ? undefined : detail?.jobs.find((each) => each.id === jobId);

  const titled = Boolean(!failed && detail && header && (jobId === undefined || job));
  let body: ReactNode;
  if (failed) body = <Empty>Couldn't load this run. Try again in a moment.</Empty>;
  else if (!detail) body = <JobsPlaceholder rows={Math.max(run?.environments.length ?? 0, 2)} />;
  else if (!header) body = <Empty>Nothing is known about this run yet.</Empty>;
  else if (jobId !== undefined)
    body = job ? (
      <JobView ids={ids} header={header} job={job} now={now} running={running} label={label} />
    ) : (
      <Empty>This job isn't part of the run anymore.</Empty>
    );
  else
    body = (
      <RunView
        ids={ids}
        run={run}
        header={header}
        jobs={detail.jobs}
        outcome={run ?? outcome!}
        now={now}
        running={running}
        label={label}
      />
    );

  return (
    <Sheet open onOpenChange={(open) => !open && close()}>
      <SheetContent aria-describedby={undefined}>
        {/* Each view titles the panel itself; until one shows, this names it for screen readers. */}
        {!titled && <SheetTitle className="sr-only">Workflow run</SheetTitle>}
        <div className="grid gap-6 px-5 py-5 sm:px-6">{body}</div>
      </SheetContent>
    </Sheet>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="pt-8 text-sm text-muted-foreground">{children}</p>;
}

type Label = (envKey: string) => string;

function RunView({
  ids,
  run,
  header,
  jobs,
  outcome,
  now,
  running,
  label,
}: {
  ids: RunIds;
  run: Run | undefined;
  header: RunHeader;
  jobs: RunJob[];
  outcome: { status: RunStatus; conclusion: string | null };
  now: number;
  running: boolean;
  label: Label;
}) {
  const firstQueued = Math.min(...jobs.map((job) => job.queuedAt ?? job.startedAt ?? Infinity));
  const startedAt = run?.startedAt ?? (Number.isFinite(firstQueued) ? firstQueued : null);
  const wallMs = running
    ? startedAt === null
      ? null
      : now - startedAt
    : (run?.wallMs ?? (startedAt === null ? null : now - startedAt));
  const failedJobs = jobs.filter((job) => isFailure(job.conclusion)).length;

  let longest: { job: RunJob; wait: number } | null = null;
  for (const job of jobs) {
    const wait = waitOf(job, now);
    if (isLongWait(wait) && wait > (longest?.wait ?? 0)) longest = { job, wait };
  }
  let note: string | null = null;
  if (longest) {
    const { job, wait } = longest;
    const verb = job.status === "queued" ? "has waited" : "waited";
    const runner = job.environment ? label(job.environment) : "a runner";
    note = `${job.name} ${verb} ${elapsed(wait)} for ${runner}.`;
  } else if (running) note = "Jobs that need others show up once GitHub queues them.";

  return (
    <>
      <header className="grid gap-1 pr-8">
        <SheetTitle className="flex items-center gap-2">
          <StatusIcon status={outcome.status} conclusion={outcome.conclusion} />
          <span className="min-w-0 truncate">
            {header.title ?? header.workflow ?? "Unnamed workflow"}
          </span>
        </SheetTitle>
        <SheetDescription className="pl-[26px]">
          {[header.title ? header.workflow : null, header.repository].filter(Boolean).join(" · ")}
        </SheetDescription>
      </header>

      <Facts
        items={[
          ["Started", startedAt === null ? "—" : timeAgo(startedAt)],
          ["Trigger", [triggerText(header), header.branch].filter(Boolean).join(" on ") || "—"],
          ["Jobs", failedJobs ? `${jobs.length}, ${failedJobs} failed` : String(jobs.length)],
          [
            "Duration",
            <>
              {elapsed(wallMs)}
              {run?.usualMs ? (
                <span className="block text-xs text-muted-foreground">
                  usual {elapsed(run.usualMs)}
                </span>
              ) : null}
            </>,
          ],
        ]}
      />

      {jobs.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {running ? "No jobs have been queued in this run yet." : "No jobs seen for this run."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm tabular-nums">
            <thead className="bg-secondary/40">
              <tr className="text-xs text-muted-foreground">
                <th scope="col" className="py-2 pr-4 pl-3 text-left font-normal">
                  Job
                </th>
                <th scope="col" className="py-2 pr-4 text-left font-normal">
                  Runs on
                </th>
                <th scope="col" className="py-2 pr-4 text-right font-normal">
                  Wait
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-normal">
                  Run
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {jobs.map((job) => {
                const wait = waitOf(job, now);
                const queued = job.status === "queued";
                return (
                  <tr key={job.id} className="hover:bg-secondary/30">
                    <th scope="row" className="py-2 pr-4 pl-3 text-left font-normal">
                      <Link
                        from="/history"
                        to="/history"
                        search={(prev) => ({ ...prev, run: runParam(ids), job: job.id })}
                        className="group inline-flex items-center gap-2 whitespace-nowrap"
                      >
                        <JobStatus job={job} running={running} />
                        <span className="underline-offset-4 group-hover:underline">{job.name}</span>
                      </Link>
                    </th>
                    <td className="py-2 pr-4 whitespace-nowrap">
                      {job.environment ? (
                        <ProviderLink
                          provider={providerOf({ key: job.environment })}
                          className={cn(
                            "inline-flex items-center gap-2",
                            queued && "text-muted-foreground",
                          )}
                          markClassName={cn(queued && "opacity-50")}
                        >
                          {queued
                            ? `Waiting for ${label(job.environment)}`
                            : label(job.environment)}
                        </ProviderLink>
                      ) : (
                        <span className="text-muted-foreground">No runner took it</span>
                      )}
                    </td>
                    <td
                      className={cn(
                        "py-2 pr-4 text-right",
                        isLongWait(wait) && "font-semibold text-run",
                      )}
                    >
                      {elapsed(wait)}
                    </td>
                    <td className="py-2 pr-3 text-right">{elapsed(ranOf(job, now))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {note && <p className="text-xs text-muted-foreground">{note}</p>}
      <Links>
        <ExternalLink href={header.url}>Open on GitHub</ExternalLink>
        <Link to="/performance" className={LINK}>
          Usual times in Performance
          <ChevronRightIcon aria-hidden className="size-3.5" />
        </Link>
      </Links>
    </>
  );
}

function JobView({
  ids,
  header,
  job,
  now,
  running,
  label,
}: {
  ids: RunIds;
  header: RunHeader;
  job: RunJob;
  now: number;
  running: boolean;
  label: Label;
}) {
  const [steps, setSteps] = useState<JobStep[] | null | undefined>(() => stepsCache.get(job.id));
  const [failed, setFailed] = useState(false);
  const done = job.status === "completed";
  const load = () =>
    (authDisabled ? Promise.resolve(sampleJobSteps(job)) : getJobSteps(job.id)).then((value) => {
      if (done) stepsCache.set(job.id, value);
      setSteps(value);
    });
  useEffect(() => {
    if (stepsCache.has(job.id)) return;
    setFailed(false);
    load().catch(() => setFailed(true));
    // Loaded again when the job finishes, for its last steps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.id, done]);
  useLiveRefresh(() => load().catch(() => undefined), {
    intervalMs: REFRESH_MS,
    enabled: !done && job.startedAt !== null && !authDisabled,
  });

  const wait = waitOf(job, now);
  const workflow = header.workflow ?? "Unnamed workflow";
  const performance = {
    view: "jobs" as const,
    repo: ids.repositoryId,
    workflow: header.workflow ?? undefined,
    job: job.name,
  };

  return (
    <>
      <header className="grid gap-1 pr-8">
        <nav aria-label="Run" className="flex min-w-0 items-center gap-1 text-sm">
          <Link
            from="/history"
            to="/history"
            search={(prev) => ({ ...prev, run: runParam(ids), job: undefined })}
            className="truncate text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            {header.title ? `${workflow}: ${header.title}` : workflow}
          </Link>
        </nav>
        <SheetTitle className="flex items-center gap-2">
          <JobStatus job={job} running={running} className="size-[18px]" />
          <span className="min-w-0 truncate">{job.name}</span>
        </SheetTitle>
        <SheetDescription className="pl-[26px]">{header.repository}</SheetDescription>
      </header>

      <Facts
        items={[
          ["Started", job.startedAt === null ? "Not yet" : timeAgo(job.startedAt)],
          [
            "Runs on",
            job.environment ? (
              <ProviderLink
                provider={providerOf({ key: job.environment })}
                className="inline-flex min-w-0 items-center gap-2"
              >
                <span className="truncate">{label(job.environment)}</span>
              </ProviderLink>
            ) : (
              "No runner took it"
            ),
          ],
          [
            "Waited",
            <span className={cn(isLongWait(wait) && "font-semibold text-run")}>
              {elapsed(wait)}
            </span>,
          ],
          ["Ran", elapsed(ranOf(job, now))],
        ]}
      />

      <section className="grid gap-2">
        <h3 className="text-sm font-medium">Steps</h3>
        {failed ? (
          <p className="text-sm text-muted-foreground">Couldn't load the steps from GitHub.</p>
        ) : steps === undefined ? (
          <StepsPlaceholder />
        ) : steps === null || steps.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {job.startedAt === null
              ? "Steps show once a runner picks the job up."
              : "GitHub has no steps for this job."}
          </p>
        ) : (
          <Steps steps={steps} job={job} now={now} />
        )}
      </section>

      <Links>
        <ExternalLink href={jobUrl({ ...header, runId: ids.runId, id: job.id })}>
          Open on GitHub
        </ExternalLink>
        <Link to="/performance" search={performance} className={LINK}>
          Usual times for this job
          <ChevronRightIcon aria-hidden className="size-3.5" />
        </Link>
      </Links>
    </>
  );
}

/**
 * Each step with a bar where it fell in the job: its start and length against the job's whole run,
 * so the slow steps stand out.
 */
function Steps({ steps, job, now }: { steps: JobStep[]; job: RunJob; now: number }) {
  const start = job.startedAt ?? steps[0]?.startedAt ?? now;
  const end = Math.max(job.completedAt ?? now, start + 1);
  const span = end - start;
  return (
    <ol className="divide-y rounded-lg border text-sm tabular-nums">
      {steps.map((step) => {
        const from = step.startedAt;
        const to = step.completedAt ?? (step.status === "in_progress" ? now : from);
        const ms = from === null || to === null ? null : to - from;
        const left = from === null ? 0 : Math.min(Math.max((from - start) / span, 0), 1);
        const width = ms === null ? 0 : Math.min(ms / span, 1 - left);
        return (
          <li
            key={step.number}
            className="grid grid-cols-[auto_minmax(0,1fr)_3.5rem] items-center gap-x-3 px-3 py-2 sm:grid-cols-[auto_minmax(0,1fr)_minmax(0,35%)_3.5rem]"
          >
            <StatusIcon status={step.status} conclusion={step.conclusion} className="size-4" />
            <span className="truncate" title={step.name}>
              {step.name}
            </span>
            <span aria-hidden className="relative hidden h-1.5 rounded-full bg-secondary sm:block">
              {ms !== null && (
                <span
                  className={cn(
                    "absolute inset-y-0 min-w-0.5 rounded-full",
                    isFailure(step.conclusion) ? "bg-destructive" : "bg-muted-foreground/60",
                  )}
                  style={{ left: `${left * 100}%`, width: `${width * 100}%` }}
                />
              )}
            </span>
            <span className="text-right text-muted-foreground">{elapsed(ms)}</span>
          </li>
        );
      })}
    </ol>
  );
}

function JobStatus({
  job,
  running,
  className,
}: {
  job: RunJob;
  running: boolean;
  className?: string;
}) {
  // A job left unfinished in a run that has ended never said how it went.
  if (job.status !== "completed" && !running)
    return <StatusIcon status="completed" conclusion="unknown" className={className ?? "size-4"} />;
  return (
    <StatusIcon status={job.status} conclusion={job.conclusion} className={className ?? "size-4"} />
  );
}

function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-lg border px-4 py-3 text-sm sm:grid-cols-4">
      {items.map(([term, value]) => (
        <div key={term} className="grid min-w-0 gap-0.5">
          <dt className="text-xs text-muted-foreground">{term}</dt>
          <dd className="min-w-0 break-words tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

const LINK = "inline-flex items-center gap-1 font-medium text-foreground hover:underline";

function Links({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">{children}</div>;
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={LINK}>
      {children}
      <ExternalLinkIcon aria-hidden className="size-3.5" />
    </a>
  );
}

/** Holds the space of the jobs table while a run's jobs load. */
function JobsPlaceholder({ rows }: { rows: number }) {
  return (
    <div aria-busy aria-label="Loading jobs" className="grid gap-6">
      <div className="grid gap-2 pr-8">
        <span className="h-5 w-64 max-w-full rounded-sm bg-secondary" />
        <span className="h-3 w-40 rounded-sm bg-secondary" />
      </div>
      <div className="h-14 rounded-lg border" />
      <div className="grid rounded-lg border">
        {Array.from({ length: rows + 1 }, (_, index) => (
          <div key={index} className="flex h-10 items-center gap-4 px-3">
            <span className="h-3 w-40 max-w-[40%] rounded-sm bg-secondary" />
            <span className="h-3 w-32 max-w-[30%] rounded-sm bg-secondary" />
          </div>
        ))}
      </div>
    </div>
  );
}

function StepsPlaceholder() {
  return (
    <div aria-busy aria-label="Loading steps" className="grid rounded-lg border">
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="flex h-9 items-center gap-4 px-3">
          <span className="h-3 w-48 max-w-[50%] rounded-sm bg-secondary" />
        </div>
      ))}
    </div>
  );
}
