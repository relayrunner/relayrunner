import {
  ArrowRightIcon,
  CircleCheckIcon,
  CopyIcon,
  GlobeIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { useCopy } from "@/components/add-runner";
import { AUTO_DOCS, SizeSelect } from "@/components/router-workflows";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { plural } from "@/lib/job-times";
import {
  defaultPicks,
  firstRouted,
  jobKey,
  type PickedJob,
  pickedJobs,
  repoJobCount,
  type RepoProgress,
  repoRuns,
  type RepoToRoute,
  routeAllPrompt,
  routePrompt,
  sizable,
  SKILLS_INSTALL,
} from "@/lib/route-repo";
import type { RunnerGroupBlock, RunnerGroupCheck } from "@/lib/router-setup";
import { cn } from "@/lib/utils";

const INIT_COMMAND = "npx relayrunner init";

/** Where the sheet opens: a repo picked from the Workflows list starts at its jobs. */
export type RouteStart = { repoId: number | null };

/** A size picked for a job before its repo routes. */
export type PlannedSize = { workflow: string; job: string; size: number };

/** What the sheet needs from the page beyond the repos. */
export type RouteRepoContext = {
  accessUrl: string | null;
  /** The workspace's default size for auto jobs, in vCPUs. */
  defaultSize: number;
  groupCheck: RunnerGroupCheck | null;
  /** Saves sizes for the repo's first routed run, and answers the jobs it saved. */
  onPlanSizes: (repoId: number, jobs: PlannedSize[]) => Promise<PlannedSize[]>;
  /** A prompt or command was copied: the page starts watching for the repo's first routed run. */
  onCopied: () => void;
};

/** The Router page's setup card: how far the workspace's repos are, and the way in. */
export function SetupCard({
  progress,
  onRoute,
  className,
}: {
  progress: RepoProgress;
  onRoute: () => void;
  className?: string;
}) {
  const { routed, active, left, quiet } = progress;
  return (
    <section
      aria-label="Set up a repo"
      className={cn(
        "grid min-w-0 flex-[1_1_300px] content-start gap-2 rounded-lg border border-border/60 bg-dormant px-4 py-3.5",
        className,
      )}
    >
      <h2 className="text-sm font-semibold">Set up a repo</h2>
      <p className="text-[12.5px] text-muted-foreground">
        {active === 0
          ? "Route a repo's jobs through your runner order."
          : `${routed} of ${plural(active, "repo")} routed`}
      </p>
      <Button
        size="sm"
        className="justify-self-start"
        disabled={left.length + quiet.length === 0}
        onClick={onRoute}
      >
        Route a repo
      </Button>
    </section>
  );
}

/**
 * Routes one repo at a time: pick the repo, pick its jobs, then copy a prompt for a coding agent
 * (or the `init` command) that edits the workflows and opens a PR. "Next repo" moves on, and from
 * the second repo one prompt can cover the rest.
 */
export function RouteRepoSheet({
  start,
  onClose,
  progress,
  context,
}: {
  start: RouteStart | null;
  onClose: () => void;
  progress: RepoProgress;
  context: RouteRepoContext;
}) {
  return (
    <Sheet open={!!start} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="sm:max-w-lg">
        {start && (
          <RouteRepoSteps
            // A new start (another repo's Set up) begins again.
            key={start.repoId ?? "pick"}
            start={start}
            progress={progress}
            context={context}
            onClose={onClose}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function RouteRepoSteps({
  start,
  progress,
  context,
  onClose,
}: {
  start: RouteStart;
  progress: RepoProgress;
  context: RouteRepoContext;
  onClose: () => void;
}) {
  const { accessUrl, defaultSize, groupCheck } = context;
  // The repos as the sheet opened: one that routes while it's open stays, to show its first run.
  const [repos] = useState(() => [...progress.left, ...progress.quiet]);
  const [repoId, setRepoId] = useState(start.repoId ?? repos[0]?.id ?? null);
  const [stage, setStage] = useState<Stage>(start.repoId === null ? "repo" : "jobs");
  // Each repo's checked jobs once it's been opened, by jobKey, so going back keeps them.
  const [picks, setPicks] = useState(new Map<number, Set<string>>());
  const [auto, setAuto] = useState(true);
  // Repos taken through to the last step, for "Repo n of m" and Next repo.
  const [done, setDone] = useState(new Set<number>());
  // Each repo's picked sizes by jobKey; a job left out uses the default size.
  const [sizes, setSizes] = useState(new Map<number, Map<string, number>>());
  // Repos whose prompt was copied, with the workflows to watch for a first routed run (null: any).
  const [watched, setWatched] = useState(new Map<number, string[] | null>());
  // What happened to each repo's picked sizes, once copied.
  const [saved, setSaved] = useState(new Map<number, string>());
  const repo = repos.find((r) => r.id === repoId) ?? null;
  if (!repo) return null;
  // A repo with no recent runs has no jobs to pick; init finds them.
  const hasJobs = repo.workflows.length > 0;
  const stages: Stage[] = hasJobs ? ["repo", "jobs", "route"] : ["repo", "route"];
  const at = stages.includes(stage) ? stage : "route";
  const status = (of: Stage) => Math.sign(stages.indexOf(at) - stages.indexOf(of));
  const go = (by: number) => setStage(stages[stages.indexOf(at) + by] ?? at);
  const picked = picks.get(repo.id) ?? defaultPicks(repo);
  const jobs = pickedJobs(repo, picked);
  const others = progress.left.filter((r) => r.id !== repo.id && !done.has(r.id));
  const next = others[0] ?? null;

  const repoSizes = sizes.get(repo.id) ?? new Map<string, number>();
  const blockOf = new Map(groupCheck?.blocked.map((b) => [b.repositoryId, b.block]));
  const block = blockOf.get(repo.id);
  const groupBlock = block && groupCheck ? { block, check: groupCheck } : null;
  // The sizes the copy saves: picked jobs the Router will size, set to something other than default.
  const planned: PlannedSize[] = auto
    ? repo.workflows.flatMap((w) =>
        w.jobs.flatMap((job) => {
          const key = jobKey(w.workflow, job.name);
          const size = repoSizes.get(key);
          return picked.has(key) && size !== undefined
            ? [{ workflow: w.workflow, job: job.name, size }]
            : [];
        }),
      )
    : [];

  const toggle = (key: string) => {
    const nextPicks = new Set(picked);
    if (!nextPicks.delete(key)) nextPicks.add(key);
    setPicks(new Map(picks).set(repo.id, nextPicks));
  };
  const setSize = (key: string, size: number | null) => {
    const next = new Map(repoSizes);
    if (size === null) next.delete(key);
    else next.set(key, size);
    setSizes(new Map(sizes).set(repo.id, next));
  };
  const copied = async () => {
    const id = repo.id;
    setWatched((map) =>
      new Map(map).set(id, hasJobs ? [...new Set(jobs.map((job) => job.workflow))] : null),
    );
    context.onCopied();
    if (planned.length === 0) return;
    const message = await context.onPlanSizes(id, planned).then(
      (kept) =>
        kept.length === planned.length
          ? `Saved ${plural(kept.length, "size")} for the first run.`
          : `Saved ${kept.length} of ${plural(planned.length, "size")}. Set the rest under Workflows once the repo routes.`,
      () => "Couldn't save the sizes. Set them under Workflows once the repo routes.",
    );
    setSaved((map) => new Map(map).set(id, message));
  };

  return (
    <div className="grid gap-3 px-5 py-5 sm:px-6">
      <div className="grid gap-1 pr-6">
        <SheetTitle>Route a repo</SheetTitle>
        <SheetDescription>
          {progress.left.length > 1
            ? `Repo ${Math.min(done.size + 1, progress.left.length)} of ${progress.left.length} left to route`
            : "Pick the jobs, then hand the change to your coding agent."}
        </SheetDescription>
      </div>

      <Step
        n={1}
        title="Repository"
        summary={repo.name}
        status={status("repo")}
        onEdit={() => setStage("repo")}
      >
        <div role="radiogroup" aria-label="Repository" className="grid rounded-md border">
          {progress.left.map((r) => (
            <RepoOption
              key={r.id}
              repo={r}
              checked={r.id === repo.id}
              blocked={blockOf.has(r.id)}
              onPick={setRepoId}
            />
          ))}
          {progress.quiet.length > 0 && (
            <QuietRepos repos={progress.quiet} repo={repo} onPick={setRepoId} />
          )}
        </div>
        {repo.private === false && (
          <Note icon={<GlobeIcon aria-hidden className="size-4 text-muted-foreground" />}>
            Public repo. Your machines won't take its jobs; hosted runners in your order will.
          </Note>
        )}
        {groupBlock && <GroupNote {...groupBlock} />}
        {!hasJobs && (
          <p className="text-[13px] text-muted-foreground">
            No runs in the last 14 days, so there are no jobs to pick. <code>init</code> finds them.
          </p>
        )}
        {accessUrl && (
          <p className="text-[12.5px] text-muted-foreground">
            Don't see your repo?{" "}
            <a
              href={accessUrl}
              target="_blank"
              rel="noreferrer"
              className="text-go hover:text-go-hover"
            >
              Give RelayRunner access
            </a>
          </p>
        )}
        <div className="flex justify-end">
          <Button size="sm" onClick={() => go(1)}>
            Next
            <ArrowRightIcon aria-hidden />
          </Button>
        </div>
      </Step>

      {hasJobs && (
        <Step
          n={2}
          title="Jobs"
          summary={`${jobs.length} of ${plural(repoJobCount(repo), "job")}`}
          status={status("jobs")}
          onEdit={() => setStage("jobs")}
        >
          <p className="text-[13px] text-muted-foreground">
            Pick the jobs to route. Each keeps its current runner as the fallback.
          </p>
          <div className="grid gap-3">
            {repo.workflows.map((w) => (
              <div key={w.workflow} className="grid">
                <h4 className="pb-1 text-xs font-medium text-muted-foreground">{w.workflow}</h4>
                {w.jobs.map((job) => {
                  const key = jobKey(w.workflow, job.name);
                  return (
                    <div key={key} className="flex items-center gap-3 border-t py-2 text-[13px]">
                      <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-3">
                        <input
                          type="checkbox"
                          className="mt-0.5 size-4 accent-[var(--color-go)]"
                          checked={picked.has(key)}
                          onChange={() => toggle(key)}
                        />
                        <span className="grid min-w-0 gap-0.5">
                          <span className="truncate">
                            {job.name}
                            {job.legs > 1 && (
                              <span className="text-muted-foreground"> · {job.legs} legs</span>
                            )}
                          </span>
                          <span className="truncate text-xs text-muted-foreground">
                            {[
                              job.label,
                              plural(job.runs, "run"),
                              job.minutes !== null && `${job.minutes} min`,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        </span>
                      </label>
                      {auto && sizable(job) && (
                        <SizeSelect
                          name={job.name}
                          value={repoSizes.get(key) ?? null}
                          defaultSize={defaultSize}
                          disabled={!picked.has(key)}
                          onChange={(size) => setSize(key, size)}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          <label className="flex cursor-pointer items-start gap-3 rounded-md bg-muted/50 px-3 py-2.5 text-[13px]">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-[var(--color-go)]"
              checked={auto}
              onChange={() => setAuto(!auto)}
            />
            <span>
              Pick sizes on this page with <code className="font-mono">auto</code>, with no commit.{" "}
              <a
                href={AUTO_DOCS}
                target="_blank"
                rel="noreferrer"
                className="text-go hover:text-go-hover"
              >
                What is auto?
              </a>
            </span>
          </label>
          <div className="flex items-center justify-between gap-2">
            <Button size="sm" variant="outline" onClick={() => go(-1)}>
              Back
            </Button>
            <Button size="sm" disabled={jobs.length === 0} onClick={() => go(1)}>
              Next
              <ArrowRightIcon aria-hidden />
            </Button>
          </div>
        </Step>
      )}

      <Step n={stages.length} title="Route" status={status("route")}>
        <RouteStep
          repo={repo}
          jobs={hasJobs ? jobs : null}
          auto={auto}
          // From the second repo on, one prompt can cover the rest with the same choices.
          others={done.size > 0 && others.length > 1 ? others : []}
          picks={picks}
          next={next}
          blocked={groupBlock}
          firstRun={
            watched.has(repo.id) ? firstRouted(progress, repo.id, watched.get(repo.id)!) : undefined
          }
          saved={saved.get(repo.id) ?? null}
          onCopied={() => void copied()}
          onBack={() => go(-1)}
          onNext={(target) => {
            setDone(new Set(done).add(repo.id));
            setRepoId(target.id);
            setStage("jobs");
          }}
          onClose={onClose}
        />
      </Step>
    </div>
  );
}

type Stage = "repo" | "jobs" | "route";

// The last step's body, its own component so the prompts are only built while it shows.
function RouteStep({
  repo,
  jobs,
  auto,
  others,
  picks,
  next,
  blocked,
  firstRun,
  saved,
  onCopied,
  onBack,
  onNext,
  onClose,
}: {
  repo: RepoToRoute;
  jobs: PickedJob[] | null;
  auto: boolean;
  others: RepoToRoute[];
  picks: Map<number, Set<string>>;
  next: RepoToRoute | null;
  blocked: { block: RunnerGroupBlock; check: RunnerGroupCheck } | null;
  /** Undefined before a copy, null while waiting, then the workflow that ran through a relay. */
  firstRun: string | null | undefined;
  saved: string | null;
  onCopied: () => void;
  onBack: () => void;
  onNext: (repo: RepoToRoute) => void;
  onClose: () => void;
}) {
  const prompt = routePrompt(repo.name, jobs, auto);
  return (
    <>
      <p className="text-sm font-medium">
        {jobs
          ? `Ready to route ${plural(jobs.length, "job")}`
          : "Ready to route every job init finds"}
      </p>
      {blocked && <GroupNote {...blocked} />}
      <div className="flex flex-wrap gap-2">
        <CopyText primary label="Copy agent prompt" text={prompt} onCopy={onCopied} />
        <CopyText
          label="Copy command"
          text={auto ? `${INIT_COMMAND} --auto` : INIT_COMMAND}
          onCopy={onCopied}
        />
      </div>
      <pre className="max-h-48 overflow-y-auto rounded-md border bg-muted/50 px-3 py-2.5 font-mono text-[11.5px] whitespace-pre-wrap text-muted-foreground">
        {prompt}
      </pre>
      <p className="text-[13px] text-muted-foreground">
        Paste the prompt into your coding agent. It opens a PR; merge it and the repo is routed.
      </p>
      <p className="text-[13px] text-muted-foreground">
        Give your agent the RelayRunner skills and it can route repos without a prompt.{" "}
        <CopyText link label="Copy install command" text={SKILLS_INSTALL} />
      </p>
      {saved && <p className="text-[13px] text-muted-foreground">{saved}</p>}
      {firstRun === null && (
        <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <LoaderCircleIcon aria-hidden className="size-4 shrink-0 animate-spin" />
          Waiting for the first routed run. It shows here once the PR merges and a job runs.
        </p>
      )}
      {firstRun && (
        <p className="flex items-center gap-2 text-[13px]">
          <CircleCheckIcon aria-hidden className="size-4 shrink-0 text-go" />
          {firstRun} ran through the relay. {repo.name} is routed.
        </p>
      )}
      {others.length > 0 && (
        <p className="text-[13px] text-muted-foreground">
          Same choices for the {others.length} repos left?{" "}
          <CopyText
            link
            label="Copy one prompt for all"
            text={routeAllPrompt(
              others.map((r) => ({
                name: r.name,
                jobs: pickedJobs(r, picks.get(r.id) ?? defaultPicks(r)),
              })),
              auto,
            )}
          />
        </p>
      )}
      <div className="flex items-center justify-between gap-2">
        <Button size="sm" variant="outline" onClick={onBack}>
          Back
        </Button>
        {next ? (
          <Button size="sm" variant="outline" onClick={() => onNext(next)}>
            Next repo: {next.name}
            <ArrowRightIcon aria-hidden />
          </Button>
        ) : (
          <Button size="sm" onClick={onClose}>
            Done
          </Button>
        )}
      </div>
    </>
  );
}

/** One step: a numbered header, a check and summary once passed, and its body while current. */
function Step({
  n,
  title,
  summary,
  status,
  onEdit,
  children,
}: {
  n: number;
  title: string;
  summary?: string;
  /** -1 before the current step, 0 the current one, 1 passed. */
  status: number;
  onEdit?: () => void;
  children: ReactNode;
}) {
  const current = status === 0;
  const passed = status > 0;
  const header = (
    <>
      {passed ? (
        <CircleCheckIcon aria-label="Done" className="size-5 shrink-0 text-go" />
      ) : (
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] text-muted-foreground">
          {n}
        </span>
      )}
      <span>{title}</span>
      {passed && summary && (
        <span className="ml-auto min-w-0 truncate font-mono text-xs font-normal text-muted-foreground">
          {summary}
        </span>
      )}
    </>
  );
  return (
    <section
      aria-label={title}
      className={cn("rounded-lg border", current && "border-foreground/25")}
    >
      {passed && onEdit ? (
        <button
          type="button"
          onClick={onEdit}
          className="flex w-full items-center gap-2.5 rounded-lg px-3.5 py-3 text-left text-sm font-medium outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
        >
          {header}
        </button>
      ) : (
        <h3 className="flex items-center gap-2.5 px-3.5 py-3 text-sm font-medium">{header}</h3>
      )}
      {current && <div className="grid gap-3 border-t px-3.5 py-3">{children}</div>}
    </section>
  );
}

function RepoOption({
  repo,
  checked,
  blocked = false,
  onPick,
}: {
  repo: RepoToRoute;
  checked: boolean;
  /** Left out of the org's Default runner group. */
  blocked?: boolean;
  onPick: (id: number) => void;
}) {
  const runs = repoRuns(repo);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={() => onPick(repo.id)}
      className={cn(
        "flex min-w-0 items-center gap-3 border-t px-3 py-2 text-left text-[13px] outline-none first:border-t-0 hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        checked && "bg-accent/40",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-3.5 shrink-0 rounded-full border-[1.5px] border-muted-foreground",
          checked && "border-4 border-go",
        )}
      />
      <span className="min-w-0 truncate font-mono text-[12.5px]">{repo.name}</span>
      {repo.private === false && (
        <GlobeIcon aria-label="Public" className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      {blocked && (
        <TriangleAlertIcon
          aria-label="Not in the runner group"
          className="size-3.5 shrink-0 text-run"
        />
      )}
      <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
        {runs > 0
          ? `${plural(repoJobCount(repo), "job")} · ${plural(runs, "run")}`
          : "No recent runs"}
      </span>
    </button>
  );
}

// Repos with no runs in the window, folded away: an org can have hundreds.
function QuietRepos({
  repos,
  repo,
  onPick,
}: {
  repos: RepoToRoute[];
  repo: RepoToRoute;
  onPick: (id: number) => void;
}) {
  const [open, setOpen] = useState(repos.some((r) => r.id === repo.id));
  if (!open)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="border-t px-3 py-2 text-left text-xs text-muted-foreground outline-none first:border-t-0 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        Show {plural(repos.length, "repo")} with no recent runs
      </button>
    );
  return repos.map((r) => (
    <RepoOption key={r.id} repo={r} checked={r.id === repo.id} onPick={onPick} />
  ));
}

function Note({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-[13px]">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span>{children}</span>
    </p>
  );
}

/** A button (or inline link) that copies `text`, and says so for a moment. */
function CopyText({
  text,
  label,
  primary,
  link,
  onCopy,
}: {
  text: string;
  label: string;
  primary?: boolean;
  link?: boolean;
  onCopy?: () => void;
}) {
  const { copied, copy: copyText } = useCopy(text);
  const copy = async () => {
    await copyText();
    onCopy?.();
  };
  if (link)
    return (
      <button
        type="button"
        onClick={() => void copy()}
        className="font-medium text-go outline-none hover:text-go-hover focus-visible:ring-2 focus-visible:ring-ring"
      >
        {copied ? "Copied" : label}
      </button>
    );
  return (
    <Button size="sm" variant={primary ? "default" : "outline"} onClick={() => void copy()}>
      <CopyIcon aria-hidden />
      {copied ? "Copied" : label}
    </Button>
  );
}

/** Why the org's Default runner group will keep the repo's relay jobs queued, and where to fix it. */
function GroupNote({ block, check }: { block: RunnerGroupBlock; check: RunnerGroupCheck }) {
  const group = `Your org's ${check.groupName} runner group`;
  return (
    <Note icon={<TriangleAlertIcon aria-hidden className="size-4 text-run" />}>
      {block === "not_selected"
        ? `${group} doesn't include this repo, so its routed jobs would stay queued. Add it under Repository access before you merge; GitHub can take about 20 minutes to apply it.`
        : block === "public"
          ? `${group} doesn't allow public repos, so this repo's routed jobs would stay queued. Turn on "Allow public repositories" before you merge.`
          : `${group} only allows private repos, so this repo's routed jobs would stay queued. Change its Repository access before you merge.`}{" "}
      <a
        href={check.settingsUrl}
        target="_blank"
        rel="noreferrer"
        className="text-go hover:text-go-hover"
      >
        Open runner group
      </a>
    </Note>
  );
}
