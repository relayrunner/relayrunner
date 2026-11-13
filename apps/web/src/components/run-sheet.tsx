import { Link, type LinkProps, useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, ExternalLinkIcon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { RunnerLink, type RunnerRef } from "@/components/runner-link";
import { StatusIcon } from "@/components/status-icon";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { timeAgo } from "@/lib/activity";
import { authDisabled } from "@/lib/auth-client";
import type { Environment } from "@/lib/job-times";
import { useLiveRefresh } from "@/lib/live-refresh";
import {
  getJobSteps,
  getRunJobs,
  isFailure,
  isLongWait,
  type JobStep,
  jobUrl,
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
import { useNow } from "@/lib/use-now";
import { cn, elapsed } from "@/lib/utils";

// While a run is going, how often an open run's jobs and a running job's steps are refetched.
// Paused while the tab is hidden or idle (lib/live-refresh.ts).
const REFRESH_MS = 5_000;

/** The page's environments, by key. */
export type Environments = Map<string, Environment>;

/**
 * A link that opens a run, or one of its jobs, in History's panel. The panel is a search change on
 * the page already loaded, so there's nothing to preload.
 */
export function RunLink({
  run,
  job,
  ...props
}: { run: RunIds; job?: number } & Omit<LinkProps, "to" | "from" | "search"> & {
    className?: string;
    onPointerEnter?: () => void;
    onPointerLeave?: () => void;
    onFocus?: () => void;
    "aria-current"?: "true";
  }) {
  return (
    <Link
      from="/history"
      to="/history"
      search={(prev) => ({ ...prev, run: runParam(run), job })}
      preload={false}
      {...props}
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

// A finished job's steps don't change, so the last ones read are kept.
const stepsCache = new Map<number, JobStep[] | null>();

function fetchJobSteps(job: RunJob) {
  const request = authDisabled ? Promise.resolve(sampleJobSteps(job)) : getJobSteps(job.id);
  return request.then((steps) => {
    if (job.status === "completed") {
      stepsCache.set(job.id, steps);
      if (stepsCache.size > CACHE_SIZE) stepsCache.delete(stepsCache.keys().next().value!);
    }
    return steps;
  });
}

// A job still queued has waited until now, and one still running has run until now.
function waitOf(job: RunJob, now: number) {
  if (job.queuedAt === null) return null;
  const end = job.startedAt ?? (job.status === "queued" ? now : null);
  return end === null ? null : end - job.queuedAt;
}
const ranOf = (job: RunJob, now: number) =>
  job.startedAt === null ? null : (job.completedAt ?? now) - job.startedAt;

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

  // The run's status from the list when it has it, else from the detail once that loads. The panel
  // is keyed on the run, so `ids` never changes under it.
  const [detail, setDetail] = useState<RunJobs | null>(() =>
    cachedJobs(ids, run?.status ?? "completed"),
  );
  const [failed, setFailed] = useState(false);
  const header: RunHeader | null = run ?? detail?.run ?? null;
  const status = header?.status ?? "completed";
  const running = status !== "completed";
  useEffect(() => {
    let live = true;
    fetchRunJobs(ids, run?.status ?? "completed")
      .then((value) => live && setDetail(value))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the run
  }, [run?.status]);
  useLiveRefresh(
    () =>
      fetchRunJobs(ids, status, true)
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
  const own = useMemo(() => new Map(detail?.environments.map((env) => [env.key, env])), [detail]);
  const runnerOf = (key: string): RunnerRef =>
    environments.get(key) ?? own.get(key) ?? { key, label: key };
  const job = jobId === undefined ? undefined : detail?.jobs.find((each) => each.id === jobId);

  let body: ReactNode;
  if (failed) body = <Empty>Couldn't load this run. Try again in a moment.</Empty>;
  else if (!detail) body = <JobsPlaceholder rows={Math.max(run?.environments.length ?? 0, 2)} />;
  else if (!header) body = <Empty>Nothing is known about this run yet.</Empty>;
  else if (jobId !== undefined)
    body = job ? (
      <JobView
        ids={ids}
        header={header}
        job={job}
        now={now}
        running={running}
        runnerOf={runnerOf}
      />
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
        now={now}
        running={running}
        runnerOf={runnerOf}
      />
    );

  return (
    <Sheet open onOpenChange={(open) => !open && close()}>
      <SheetContent aria-describedby={undefined} widthKey="history-panel-width">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 px-5 py-5 sm:px-6">{body}</div>
      </SheetContent>
    </Sheet>
  );
}

// Each view titles the panel itself; until one shows, this names it for screen readers.
const UNTITLED = <SheetTitle className="sr-only">Workflow run</SheetTitle>;

function Empty({ children }: { children: ReactNode }) {
  return (
    <>
      {UNTITLED}
      <p className="pt-8 text-sm text-muted-foreground">{children}</p>
    </>
  );
}

/** The runner a job ran on, by its environment key. */
type RunnerOf = (key: string) => RunnerRef;

function RunView({
  ids,
  run,
  header,
  jobs,
  now,
  running,
  runnerOf,
}: {
  ids: RunIds;
  run: Run | undefined;
  header: RunHeader;
  jobs: RunJob[];
  now: number;
  running: boolean;
  runnerOf: RunnerOf;
}) {
  const firstQueued = Math.min(...jobs.map((job) => job.queuedAt ?? job.startedAt ?? Infinity));
  const startedAt = run?.startedAt ?? (Number.isFinite(firstQueued) ? firstQueued : null);
  const wallMs = (running ? null : run?.wallMs) ?? (startedAt === null ? null : now - startedAt);
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
    const runner = job.environment ? runnerOf(job.environment).label : "a runner";
    note = `${job.name} ${verb} ${elapsed(wait)} for ${runner}.`;
  } else if (running) note = "Jobs that need others show up once GitHub queues them.";

  return (
    <>
      <header className="grid gap-1 pr-8">
        <SheetTitle className="flex items-start gap-2">
          <StatusIcon status={header.status} conclusion={header.conclusion} className="mt-0.5" />
          <span className="min-w-0 break-words">
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
                const runner = job.environment ? runnerOf(job.environment) : null;
                return (
                  <tr key={job.id} className="hover:bg-secondary/30">
                    <th scope="row" className="py-2 pr-4 pl-3 text-left font-normal">
                      <RunLink
                        run={ids}
                        job={job.id}
                        className="group inline-flex items-start gap-2"
                      >
                        <JobStatus job={job} running={running} className="mt-0.5 size-4" />
                        <span className="underline-offset-4 group-hover:underline">{job.name}</span>
                      </RunLink>
                    </th>
                    <td className="py-2 pr-4">
                      {runner ? (
                        <RunnerLink
                          runner={runner}
                          className={cn(
                            "inline-flex items-center gap-2",
                            queued && "text-muted-foreground",
                          )}
                          markClassName={cn(queued && "opacity-50")}
                        >
                          {queued ? `Waiting for ${runner.label}` : runner.label}
                        </RunnerLink>
                      ) : (
                        <span className="text-muted-foreground">No runner took it</span>
                      )}
                    </td>
                    <td
                      className={cn(
                        "py-2 pr-4 text-right whitespace-nowrap",
                        isLongWait(wait) && "font-semibold text-run",
                      )}
                    >
                      {elapsed(wait)}
                    </td>
                    <td className="py-2 pr-3 text-right whitespace-nowrap">
                      {elapsed(ranOf(job, now))}
                    </td>
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
  runnerOf,
}: {
  ids: RunIds;
  header: RunHeader;
  job: RunJob;
  now: number;
  running: boolean;
  runnerOf: RunnerOf;
}) {
  // Undefined while loading; null when GitHub has no steps for the job.
  const [steps, setSteps] = useState<JobStep[] | null | undefined>(() => stepsCache.get(job.id));
  const [failed, setFailed] = useState(false);
  const started = job.startedAt !== null;
  const done = job.status === "completed";
  // Read once the job has started, and again when it finishes, for its last steps.
  useEffect(() => {
    if (!started || stepsCache.has(job.id)) return;
    let live = true;
    fetchJobSteps(job)
      .then((value) => live && setSteps(value))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `job` is a new object every refresh
  }, [job.id, started, done]);
  useLiveRefresh(
    () =>
      fetchJobSteps(job)
        .then(setSteps)
        .catch(() => undefined),
    { intervalMs: REFRESH_MS, enabled: started && !done && !authDisabled },
  );

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
          <RunLink
            run={ids}
            className="truncate text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            {header.title ? `${workflow}: ${header.title}` : workflow}
          </RunLink>
        </nav>
        <SheetTitle className="flex items-start gap-2">
          <JobStatus job={job} running={running} className="mt-0.5 size-[18px]" />
          <span className="min-w-0 break-words">{job.name}</span>
        </SheetTitle>
        <SheetDescription className="pl-[26px]">{header.repository}</SheetDescription>
      </header>

      <Facts
        items={[
          ["Started", job.startedAt === null ? "Not yet" : timeAgo(job.startedAt)],
          [
            "Runs on",
            job.environment ? (
              <RunnerLink
                runner={runnerOf(job.environment)}
                className="inline-flex min-w-0 items-center gap-2"
              >
                <span className="truncate">{runnerOf(job.environment).label}</span>
              </RunnerLink>
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
        ) : !started ? (
          <p className="text-sm text-muted-foreground">
            Steps show once a runner picks the job up.
          </p>
        ) : steps === undefined ? (
          <StepsPlaceholder />
        ) : steps === null || steps.length === 0 ? (
          <p className="text-sm text-muted-foreground">GitHub has no steps for this job.</p>
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
  className = "size-4",
}: {
  job: RunJob;
  running: boolean;
  className?: string;
}) {
  // A job left unfinished in a run that has ended never said how it went.
  const stale = job.status !== "completed" && !running;
  return (
    <StatusIcon
      status={stale ? "completed" : job.status}
      conclusion={stale ? "unknown" : job.conclusion}
      className={className}
    />
  );
}

// Four facts, each column as wide as its value, with the second (the long one) taking what's left.
function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-lg border px-4 py-3 text-sm sm:grid-cols-[auto_minmax(0,1fr)_auto_auto]">
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
      {UNTITLED}
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
