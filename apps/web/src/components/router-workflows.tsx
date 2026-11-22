import { AUTO_SIZES } from "@relayrunner/providers";
import { RUNNER_LABELS, type RunnerKey } from "@relayrunner/runner-order";
import { ChevronRightIcon, SlidersVerticalIcon } from "lucide-react";
import { useState } from "react";
import { ProviderMark } from "@/components/providers";
import { DOCS_URL } from "@/components/site-footer";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type AutoJob, autoJobName } from "@/lib/auto-jobs";
import { plural } from "@/lib/job-times";
import { readFlag, saveFlag } from "@/lib/stored-flag";
import type { RouterSetup, SetupWorkflow } from "@/lib/router-setup";
import { cn, count, exact } from "@/lib/utils";

const DEFAULT = "default";
const ORDER = "order";
export const AUTO_DOCS = `${DOCS_URL}/reference/relay-inputs#auto-sizes`;

type Workflow = Pick<SetupWorkflow, "repositoryId" | "repository" | "workflow"> &
  Partial<Pick<SetupWorkflow, "runs" | "routedRuns">> & { autoJobs: AutoJob[] };

/**
 * The workspace's workflows by repo, from their runs in the last `days` days, and whether they go
 * through a relay. Each repo is one row that opens to its routed workflows and a line naming the
 * rest. Repos start closed and each browser remembers which it opened. A workflow with auto jobs (a relay set to `auto`) opens a
 * panel listing them with the size and first provider the Router picks for each. Owners and admins
 * change those there; each change saves.
 */
export function RouterWorkflows({
  workspaceId,
  setup,
  jobs,
  defaultSize,
  steps,
  onChange,
  toRoute,
  onSetUp,
}: {
  workspaceId: string;
  setup: RouterSetup | null;
  jobs: AutoJob[];
  defaultSize: number;
  // The providers in the runner order, for "try first".
  steps: RunnerKey[];
  onChange: (job: AutoJob, setting: Pick<AutoJob, "size" | "first">) => Promise<void>;
  /** Repos with workflows left to route, which get a Set up link. */
  toRoute: Set<number>;
  /** Opens the "Route a repo" sheet at a repo's jobs. */
  onSetUp: (repositoryId: number) => void;
}) {
  // The workflow whose auto jobs the panel shows, by workflowKey.
  const [openKey, setOpenKey] = useState<string | null>(null);
  const workflows = mergeWorkflows(setup?.workflows ?? [], jobs);
  const open = workflows.find((w) => workflowKey(w) === openKey);
  if (workflows.length === 0) return null;
  const repos = new Map<number, Workflow[]>();
  for (const w of workflows) repos.set(w.repositoryId, [...(repos.get(w.repositoryId) ?? []), w]);

  return (
    <section aria-label="Workflows" className="grid gap-2 rounded-xl border px-4 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h2 className="text-sm font-semibold">Workflows</h2>
        <p className="text-xs text-muted-foreground">last {setup?.days ?? 14} days</p>
      </div>
      <div className="grid divide-y border-t">
        {[...repos].map(([id, repoWorkflows]) => (
          <RepoWorkflows
            key={id}
            workspaceId={workspaceId}
            workflows={repoWorkflows}
            onOpen={(w) => setOpenKey(workflowKey(w))}
            onSetUp={toRoute.has(id) ? () => onSetUp(id) : undefined}
          />
        ))}
      </div>
      <Sheet open={!!open} onOpenChange={(next) => !next && setOpenKey(null)}>
        <SheetContent className="sm:max-w-lg">
          {open && (
            <div className="grid gap-4 px-5 py-5 sm:px-6">
              <div className="grid gap-1">
                <SheetTitle>{open.workflow}</SheetTitle>
                <SheetDescription>{open.repository}</SheetDescription>
              </div>
              <p className="text-[13px] text-muted-foreground">
                {open.autoJobs.some((job) => job.canEdit)
                  ? "Pick each job's size and the provider it tries first. Changes apply to the next run."
                  : "Owners, admins and people who can push to this repo can change these."}
              </p>
              <AutoJobRows
                jobs={open.autoJobs}
                defaultSize={defaultSize}
                steps={steps}
                onChange={onChange}
              />
            </div>
          )}
        </SheetContent>
      </Sheet>
    </section>
  );
}

const isRouted = (w: Workflow) => (w.routedRuns ?? 0) > 0 || w.autoJobs.length > 0;

// One repo: a row with how many of its workflows are routed, which opens to the routed ones and a
// line naming the rest. Repos start closed; each browser remembers the ones it opened.
function RepoWorkflows({
  workspaceId,
  workflows,
  onOpen,
  onSetUp,
}: {
  workspaceId: string;
  workflows: Workflow[];
  onOpen: (workflow: Workflow) => void;
  onSetUp?: () => void;
}) {
  // Every workflow here shares the repo; the first one names it.
  const { repositoryId, repository } = workflows[0]!;
  const openKey = `router-repo-open:${workspaceId}:${repositoryId}`;
  const [expanded, setExpanded] = useState(() => readFlag(openKey));
  const routed = workflows.filter(isRouted);
  const left = workflows.filter((w) => !isRouted(w)).map((w) => w.workflow);
  const toggle = () => {
    setExpanded(!expanded);
    saveFlag(openKey, !expanded);
  };
  const setUpLink = onSetUp && (
    <button
      type="button"
      onClick={onSetUp}
      className="shrink-0 rounded text-xs font-medium text-go outline-none hover:text-go-hover focus-visible:ring-2 focus-visible:ring-ring"
    >
      Set up
    </button>
  );
  return (
    <div className="grid gap-1 py-2">
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={toggle}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-90",
            )}
          />
          <span className="min-w-0 truncate text-[13px] font-semibold">{repository}</span>
          {routed.length > 0 && (
            <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
              {routed.length} of {workflows.length}
            </span>
          )}
        </button>
        {routed.length === 0 && setUpLink}
      </div>
      {expanded && (
        <div className="grid pl-5.5 text-sm">
          {routed.map((w) => {
            const runs = w.runs !== undefined && (
              <span
                className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums"
                title={`${exact(w.routedRuns ?? 0)} of ${exact(w.runs)} runs routed`}
              >
                {w.routedRuns && w.routedRuns < w.runs
                  ? `${count(w.routedRuns)} of ${count(w.runs)} runs`
                  : plural(w.runs, "run")}
              </span>
            );
            return w.autoJobs.length > 0 ? (
              <button
                key={w.workflow}
                type="button"
                onClick={() => onOpen(w)}
                className="-mx-2 flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="min-w-0 truncate">{w.workflow}</span>
                <SlidersVerticalIcon
                  aria-label={`Sizes set here for ${plural(w.autoJobs.length, "job")}`}
                  className="size-3.5 shrink-0 text-muted-foreground"
                />
                {runs}
              </button>
            ) : (
              <div key={w.workflow} className="flex min-w-0 items-center gap-1.5 py-1">
                <span className="min-w-0 truncate">{w.workflow}</span>
                {runs}
              </div>
            );
          })}
          {left.length > 0 && (
            <p className={cn("text-[13px] text-muted-foreground", routed.length > 0 && "pt-1")}>
              {listNames(left)} {left.length === 1 ? "isn't" : "aren't"} routed.{" "}
              {/* A repo with nothing routed has its Set up link on its own row. */}
              {routed.length > 0 && setUpLink}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Names a few workflows in a sentence: "A, B and 3 more". */
function listNames(names: string[], shown = 3) {
  if (names.length <= shown + 1) {
    return new Intl.ListFormat("en", { type: "conjunction" }).format(names);
  }
  return `${names.slice(0, shown).join(", ")} and ${names.length - shown} more`;
}

function AutoJobRows({
  jobs,
  defaultSize,
  steps,
  onChange,
}: {
  jobs: AutoJob[];
  defaultSize: number;
  steps: RunnerKey[];
  onChange: (job: AutoJob, setting: Pick<AutoJob, "size" | "first">) => Promise<void>;
}) {
  return (
    <table className="w-full text-[13px]">
      <thead>
        <tr className="text-left text-xs text-muted-foreground">
          <th className="py-1 pr-4 font-normal">Job</th>
          <th className="py-1 pr-4 font-normal">Size</th>
          <th className="py-1 font-normal">Try first</th>
        </tr>
      </thead>
      <tbody>
        {jobs.map((job) => (
          <tr key={job.id} className="border-t">
            <td className="py-1.5 pr-4">
              <span title={`${job.relayJob} in ${job.workflowPath}`}>{autoJobName(job)}</span>
            </td>
            <td className="py-1.5 pr-4">
              <SizeSelect
                name={autoJobName(job)}
                value={job.size}
                defaultSize={defaultSize}
                disabled={!job.canEdit}
                onChange={(size) => void onChange(job, { size, first: job.first })}
              />
            </td>
            <td className="py-1.5">
              <Select
                value={job.first ?? ORDER}
                disabled={!job.canEdit}
                onValueChange={(value) =>
                  void onChange(job, {
                    size: job.size,
                    first: value === ORDER ? null : (value as RunnerKey),
                  })
                }
              >
                <SelectTrigger
                  size="sm"
                  aria-label={`${autoJobName(job)} first runner`}
                  className="h-7 px-2 text-[13px]"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ORDER}>Runner order</SelectItem>
                  {(job.first && !steps.includes(job.first) ? [...steps, job.first] : steps).map(
                    (key) => (
                      <SelectItem key={key} value={key}>
                        <ProviderMark provider={key} />
                        {RUNNER_LABELS[key]}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// The setup's workflows with each one's auto jobs, plus any workflow only an auto job names (one
// that hasn't finished a run in the window). Not routed first, then the busiest, as the setup sorts.
const workflowKey = (w: Workflow) => `${w.repositoryId}:${w.workflow}`;

function mergeWorkflows(workflows: SetupWorkflow[], jobs: AutoJob[]): Workflow[] {
  const key = (repositoryId: number, workflow: string) => `${repositoryId}:${workflow}`;
  const merged = new Map<string, Workflow>(
    workflows.map((w) => [key(w.repositoryId, w.workflow), { ...w, autoJobs: [] }]),
  );
  for (const job of jobs) {
    const workflow = job.workflow ?? job.workflowPath;
    const id = key(job.repositoryId, workflow);
    const entry = merged.get(id) ?? {
      repositoryId: job.repositoryId,
      repository: job.repository,
      workflow,
      autoJobs: [],
    };
    entry.autoJobs.push(job);
    merged.set(id, entry);
  }
  return [...merged.values()];
}

/** A job's size: the workspace default (null), or a vCPU count. */
export function SizeSelect({
  name,
  value,
  defaultSize,
  disabled,
  onChange,
}: {
  name: string;
  value: number | null;
  defaultSize: number;
  disabled: boolean;
  onChange: (size: number | null) => void;
}) {
  return (
    <Select
      value={value === null ? DEFAULT : String(value)}
      disabled={disabled}
      onValueChange={(next) => onChange(next === DEFAULT ? null : Number(next))}
    >
      <SelectTrigger
        size="sm"
        aria-label={`${name} size`}
        className="h-7 shrink-0 px-2 text-[13px]"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={DEFAULT}>Default · {defaultSize} vCPU</SelectItem>
        {AUTO_SIZES.map((size) => (
          <SelectItem key={size} value={String(size)}>
            {size} vCPU
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
