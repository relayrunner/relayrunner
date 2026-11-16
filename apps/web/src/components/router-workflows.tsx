import { AUTO_SIZES } from "@relayrunner/providers";
import { RUNNER_LABELS, type RunnerKey } from "@relayrunner/runner-order";
import { CheckIcon, MinusIcon, PinIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { CopyCommand } from "@/components/add-runner";
import { ProviderMark } from "@/components/providers";
import { DOCS_URL } from "@/components/site-footer";
import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
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
import { count, exact } from "@/lib/utils";

/** Workflows shown per repo before "Show all". */
const FIRST_ROWS = 6;
const ALL = "all";
const DEFAULT = "default";
const ORDER = "order";
const HINT_KEY = "rr-auto-hint-dismissed";
const AUTO_DOCS = `${DOCS_URL}/reference/relay-inputs#auto-sizes`;

type Workflow = Pick<SetupWorkflow, "repositoryId" | "repository" | "workflow"> &
  Partial<Pick<SetupWorkflow, "runs" | "routedRuns">> & { jobs: AutoJob[] };

/**
 * The workspace's workflows by repo, from their runs in the last `days` days, and whether they go
 * through a relay. Under each workflow, its auto jobs (a relay set to `auto`) with the size and
 * first provider the Router picks for them. Owners and admins change those; each change saves.
 */
export function RouterWorkflows({
  setup,
  jobs,
  defaultSize,
  steps,
  editable,
  onChange,
}: {
  setup: RouterSetup | null;
  jobs: AutoJob[];
  defaultSize: number;
  // The providers in the runner order, for "try first".
  steps: RunnerKey[];
  editable: boolean;
  onChange: (job: AutoJob, setting: Pick<AutoJob, "size" | "first">) => Promise<void>;
}) {
  const [repo, setRepo] = useState(ALL);
  const [hintDismissed, setHintDismissed] = useState(() => readFlag(HINT_KEY));
  const workflows = mergeWorkflows(setup?.workflows ?? [], jobs);
  if (workflows.length === 0) return null;
  const repos = [...new Set(workflows.map((w) => w.repository))].sort();
  const shown = repo === ALL ? repos : repos.filter((r) => r === repo);
  const routed = workflows.filter((w) => (w.routedRuns ?? 0) > 0 || w.jobs.length > 0).length;

  return (
    <section aria-label="Workflows" className="grid gap-3 rounded-xl border px-4 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 className="text-sm font-semibold">Workflows</h2>
        <div className="flex items-center gap-3">
          <p className="text-xs text-muted-foreground">
            {routed} of {workflows.length} routed · last {setup?.days ?? 14} days
          </p>
          {repos.length > 1 && (
            <Select value={repo} onValueChange={setRepo}>
              <SelectTrigger size="sm" aria-label="Repo" className="h-7 px-2 text-[13px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem value={ALL}>All repos</SelectItem>
                {repos.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>
      {jobs.length === 0 && !hintDismissed && (
        <AutoHint
          provider={steps.find((key) => key !== "machine" && key !== "github") ?? "github"}
          onDismiss={() => {
            saveFlag(HINT_KEY, true);
            setHintDismissed(true);
          }}
        />
      )}
      {shown.map((name) => (
        <RepoWorkflows
          key={name}
          name={name}
          workflows={workflows.filter((w) => w.repository === name)}
          defaultSize={defaultSize}
          steps={steps}
          editable={editable}
          onChange={onChange}
        />
      ))}
    </section>
  );
}

function RepoWorkflows({
  name,
  workflows,
  ...rest
}: {
  name: string;
  workflows: Workflow[];
  defaultSize: number;
  steps: RunnerKey[];
  editable: boolean;
  onChange: (job: AutoJob, setting: Pick<AutoJob, "size" | "first">) => Promise<void>;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? workflows : workflows.slice(0, FIRST_ROWS);
  return (
    <div className="grid gap-1.5 border-t pt-3">
      <h3 className="text-[13px] font-semibold">{name}</h3>
      <ul className="grid gap-1.5 text-sm">
        {shown.map((w) => (
          <li key={w.workflow} className="grid gap-1">
            <div className="flex min-w-0 items-center gap-2.5">
              {(w.routedRuns ?? 0) > 0 || w.jobs.length > 0 ? (
                <CheckIcon aria-label="Routed" className="size-4 shrink-0 text-go" />
              ) : (
                <MinusIcon
                  aria-label="Not routed"
                  className="size-4 shrink-0 text-muted-foreground"
                />
              )}
              <span className="min-w-0 truncate">{w.workflow}</span>
              {(w.routedRuns ?? 0) > 0 && w.jobs.length === 0 && <PinnedNote />}
              {w.runs !== undefined && (
                <span
                  className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums"
                  title={`${exact(w.routedRuns ?? 0)} of ${exact(w.runs)} runs`}
                >
                  {!w.routedRuns
                    ? "Not routed"
                    : w.routedRuns === w.runs
                      ? plural(w.runs, "run")
                      : `${count(w.routedRuns)} of ${count(w.runs)} runs`}
                </span>
              )}
            </div>
            {w.jobs.length > 0 && <AutoJobRows jobs={w.jobs} {...rest} />}
          </li>
        ))}
      </ul>
      {workflows.length > FIRST_ROWS && (
        <Button
          variant="ghost"
          size="sm"
          className="justify-self-start"
          onClick={() => setAll(!all)}
        >
          {all ? "Show fewer" : `Show all ${workflows.length}`}
        </Button>
      )}
    </div>
  );
}

// Shown once, until dismissed, while no job uses `auto`: what it does and the line to write.
function AutoHint({ provider, onDismiss }: { provider: RunnerKey; onDismiss: () => void }) {
  return (
    <div className="flex items-start gap-3 rounded-lg bg-muted/50 px-3 py-2.5">
      <div className="grid min-w-0 flex-1 gap-2">
        <p className="text-[13px]">
          Pick each job's runner size here, with no commit. In a relay, write{" "}
          <code className="font-mono">auto</code> in place of a label.{" "}
          <a
            href={AUTO_DOCS}
            target="_blank"
            rel="noreferrer"
            className="text-go hover:text-go-hover"
          >
            How it works
          </a>
        </p>
        <div className="max-w-60">
          <CopyCommand command={`${provider}: auto`} prompt={false} />
        </div>
      </div>
      <Button size="icon-sm" variant="ghost" aria-label="Dismiss" onClick={onDismiss}>
        <XIcon aria-hidden />
      </Button>
    </div>
  );
}

// A routed workflow with no auto jobs: its relays name their labels, so sizes live in the file.
function PinnedNote() {
  return (
    <HoverCard openDelay={150}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          className="flex shrink-0 items-center gap-1 rounded text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <PinIcon aria-hidden className="size-3" />
          Pinned
        </button>
      </HoverCardTrigger>
      <HoverCardContent className="grid w-72 gap-2 text-[13px] text-muted-foreground">
        <p>
          <span className="font-medium text-foreground">Labels pinned in the workflow file.</span>{" "}
          Its jobs run on the labels their relays name, at the size those labels set.
        </p>
        <p>
          Write <code className="font-mono text-foreground">auto</code> in place of a label, such as{" "}
          <code className="font-mono text-foreground">blacksmith: auto</code>, to pick the size here
          instead.{" "}
          <a
            href={AUTO_DOCS}
            target="_blank"
            rel="noreferrer"
            className="text-go hover:text-go-hover"
          >
            Auto sizes
          </a>
        </p>
      </HoverCardContent>
    </HoverCard>
  );
}

function AutoJobRows({
  jobs,
  defaultSize,
  steps,
  editable,
  onChange,
}: {
  jobs: AutoJob[];
  defaultSize: number;
  steps: RunnerKey[];
  editable: boolean;
  onChange: (job: AutoJob, setting: Pick<AutoJob, "size" | "first">) => Promise<void>;
}) {
  return (
    <table className="mb-1 ml-6.5 max-w-xl text-[13px]">
      <thead>
        <tr className="text-left text-xs text-muted-foreground">
          <th className="w-36 py-1 pr-4 font-normal">Job</th>
          <th className="w-48 py-1 pr-4 font-normal">Size</th>
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
              <Select
                value={job.size === null ? DEFAULT : String(job.size)}
                disabled={!editable}
                onValueChange={(value) =>
                  void onChange(job, {
                    size: value === DEFAULT ? null : Number(value),
                    first: job.first,
                  })
                }
              >
                <SelectTrigger
                  size="sm"
                  aria-label={`${autoJobName(job)} size`}
                  className="h-7 px-2 text-[13px]"
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
            </td>
            <td className="py-1.5">
              <Select
                value={job.first ?? ORDER}
                disabled={!editable}
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
                        <ProviderMark provider={key} className="size-4 [&_svg]:size-3" />
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
function mergeWorkflows(workflows: SetupWorkflow[], jobs: AutoJob[]): Workflow[] {
  const key = (repositoryId: number, workflow: string) => `${repositoryId}:${workflow}`;
  const merged = new Map<string, Workflow>(
    workflows.map((w) => [key(w.repositoryId, w.workflow), { ...w, jobs: [] }]),
  );
  for (const job of jobs) {
    const workflow = job.workflow ?? job.workflowPath;
    const id = key(job.repositoryId, workflow);
    const entry = merged.get(id) ?? {
      repositoryId: job.repositoryId,
      repository: job.repository,
      workflow,
      jobs: [],
    };
    entry.jobs.push(job);
    merged.set(id, entry);
  }
  return [...merged.values()];
}
