// Evaluate a provider: run one workflow on it five times and compare with how it runs today
// (apps/api/src/reports/evaluations.ts). Without `?id` it walks through connecting the provider and
// picking a workflow; with one it shows that evaluation's runs, then the comparison.
import { providerPlans } from "@relayrunner/providers";
import { createFileRoute, Link, notFound, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpRightIcon,
  CheckIcon,
  CircleDashedIcon,
  SquareIcon,
  ClockIcon,
  GitBranchIcon,
  LoaderCircleIcon,
  PlayIcon,
  PlugIcon,
  RotateCcwIcon,
  TriangleAlertIcon,
  WorkflowIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { CodeBlock } from "@/components/code-block";
import { providerStyle, TILE } from "@/components/providers";
import { StatTile } from "@/components/stat-tile";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { errorText } from "@/lib/api";
import {
  ACTIVE_STATES,
  RECENT_DAYS,
  type Attempt,
  cancelEvaluation,
  editUrl,
  type EvaluationReport,
  type EvaluationWorkflow,
  evaluationSizes,
  EVALUATION_RUNS,
  getEvaluation,
  getEvaluationWorkflows,
  getRunHistory,
  listEvaluations,
  retryEvaluation,
  runUrl,
  type Split,
  startEvaluation,
} from "@/lib/evaluations";
import { clock, plural } from "@/lib/job-times";
import { usePageTitle } from "@/lib/page-title";
import { isKnownProvider, providerInfo } from "@/lib/provider-catalog";
import { getProviderApps } from "@/lib/provider-apps";
import { canManage } from "@/lib/roles";
import { routePrompt } from "@/lib/route-repo";
import { useCopy } from "@/components/add-runner";
import { cn } from "@/lib/utils";
import { EVALUATE_STEP, EvaluateStepper } from "@/components/evaluate-stepper";

type EvaluateSearch = { id?: string };

export const Route = createFileRoute("/_authed/_workspace/providers/$provider_/evaluate")({
  validateSearch: (search: Record<string, unknown>): EvaluateSearch => ({
    id: typeof search.id === "string" && search.id ? search.id : undefined,
  }),
  beforeLoad: ({ params }) => {
    if (!isKnownProvider(params.provider) || evaluationSizes(params.provider).length === 0)
      throw notFound();
  },
  component: EvaluatePage,
});

// How often a running evaluation, and the setup's checks, look again.
const POLL_MS = 10_000;

function EvaluatePage() {
  const { provider } = Route.useParams();
  const { id } = Route.useSearch();
  const { current } = Route.useRouteContext();
  const info = providerInfo(provider);
  usePageTitle(`Evaluate ${info.name}`);
  return (
    <section className="grid max-w-5xl gap-8">
      <Link
        to="/providers/$provider"
        params={{ provider }}
        className="flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon aria-hidden className="size-4" />
        {info.name}
      </Link>
      {id ? (
        <EvaluationView key={id} id={id} provider={provider} editable={canManage(current.role)} />
      ) : (
        <>
          <EvaluateHeader provider={provider} />
          <Setup
            provider={provider}
            workspaceId={current.workspace.id}
            editable={canManage(current.role)}
          />
        </>
      )}
    </section>
  );
}

/**
 * The page's title. Before an evaluation runs it explains what one does; once it runs, the run's
 * repo, branch and runner label take that line, with the page's actions beside the title.
 */
function EvaluateHeader({
  provider,
  report,
  actions,
}: {
  provider: string;
  report?: EvaluationReport;
  actions?: ReactNode;
}) {
  const { name } = providerInfo(provider);
  const { icon, tile } = providerStyle(provider);
  return (
    <header className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between md:gap-6">
      <div className="flex min-w-0 flex-1 items-center gap-3.5">
        <span className={cn(TILE, "size-12 rounded-[10px] [&_svg]:scale-150", tile)}>{icon}</span>
        <div className="grid min-w-0 gap-1">
          <h1 className="text-2xl leading-tight font-bold tracking-[-0.01em]">Evaluate {name}</h1>
          {report ? (
            <RunMeta report={report} />
          ) : (
            <p className="text-muted-foreground">
              Run one of your workflows on {name} {EVALUATION_RUNS} times and compare it with how it
              runs today. Your Router isn't used or changed.
            </p>
          )}
        </div>
      </div>
      {actions && <div className="shrink-0">{actions}</div>}
    </header>
  );
}

/** Calls `load` now and every POLL_MS while `polling`, keeping the last answer. */
function usePolled<T>(load: () => Promise<T>, polling: boolean, deps: unknown[]) {
  // Undefined until the first answer, since null can be an answer.
  const [value, setValue] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const run = () =>
      load().then(
        (next) => live && (setValue(next), setError(null)),
        (caught) => live && setError(errorText(caught)),
      );
    void run();
    const timer = polling ? setInterval(run, POLL_MS) : undefined;
    return () => {
      live = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polling, ...deps]);
  return { value, error };
}

// ---- Setup: connect, then choose -----------------------------------------------------------------

function Setup({
  provider,
  workspaceId,
  editable,
}: {
  provider: string;
  workspaceId: string;
  editable: boolean;
}) {
  // Null: GitHub can't tell (a personal account), so it isn't asked.
  const apps = usePolled(() => getProviderApps(workspaceId), true, [workspaceId]);
  const loaded = apps.value !== undefined || apps.error !== null;
  const connected = !apps.value || apps.value.includes(provider as never);
  if (!loaded) return <EvaluateStepper at={EVALUATE_STEP.provider} provider={provider} />;
  return (
    <>
      <EvaluateStepper
        at={connected ? EVALUATE_STEP.choose : EVALUATE_STEP.provider}
        provider={provider}
      />
      {connected ? (
        <Choose provider={provider} editable={editable} />
      ) : (
        <Connect provider={provider} />
      )}
    </>
  );
}

function Connect({ provider }: { provider: string }) {
  const { name } = providerInfo(provider);
  const connectUrl = providerPlans(provider)?.connectUrl ?? providerInfo(provider).docsUrl;
  return (
    <div className="grid max-w-3xl gap-6">
      <div className="grid gap-4 rounded-xl border bg-card p-5">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full border bg-raised-2">
            <PlugIcon aria-hidden className="size-4" />
          </span>
          <div className="grid gap-1">
            <span className="font-semibold">Connect {name} first</span>
            <span className="text-sm text-muted-foreground">
              {name} runs jobs for organizations that have its GitHub App installed. Sign up there
              and install it on your organization; this page moves on as soon as it sees the app.
            </span>
          </div>
        </div>
        <ol className="grid gap-2.5 border-t pt-4 text-sm">
          <li className="flex items-center gap-3">
            <span className="flex size-5 items-center justify-center rounded-full border text-xs">
              1
            </span>
            Sign up for {name}
          </li>
          <li className="flex items-center gap-3">
            <span className="flex size-5 items-center justify-center rounded-full border text-xs">
              2
            </span>
            Install the {name} GitHub App on your organization
          </li>
          <li className="flex items-center gap-3 text-muted-foreground">
            <LoaderCircleIcon aria-hidden className="size-5 animate-spin text-run" />
            Looking for the app on your organization
          </li>
        </ol>
      </div>
      {connectUrl && (
        <div className="flex flex-wrap items-center gap-3">
          <Button asChild>
            <a href={connectUrl} target="_blank" rel="noreferrer">
              Connect {name}
              <ArrowUpRightIcon className="size-3.5" />
            </a>
          </Button>
          <span className="text-sm text-muted-foreground">Opens {name} in a new tab.</span>
        </div>
      )}
    </div>
  );
}

const workflowKey = (w: Pick<EvaluationWorkflow, "repositoryId" | "path">) =>
  `${w.repositoryId}:${w.path}`;
const workflowFile = (path: string) => path.split("/").pop() ?? path;

function Choose({ provider, editable }: { provider: string; editable: boolean }) {
  const { name } = providerInfo(provider);
  const navigate = useNavigate();
  const sizes = evaluationSizes(provider);
  // A new workspace's runs are still coming in from GitHub (apps/api run-history). Its workflows
  // come from GitHub's own list meanwhile, so nothing here waits: rows fill in their stats as the
  // runs land, and the comparison reads them when it's shown.
  const [historyPolling, setHistoryPolling] = useState(true);
  const history = usePolled(getRunHistory, historyPolling, []);
  const importing = history.value?.state === "queued" || history.value?.state === "running";
  useEffect(() => {
    if (history.value !== undefined || history.error) setHistoryPolling(importing);
  }, [history.value, history.error, importing]);
  const workflows = usePolled(getEvaluationWorkflows, true, []);
  const active = usePolled(() => listEvaluations(provider), false, [provider]).value?.filter((e) =>
    ACTIVE_STATES.includes(e.state),
  );
  const list = workflows.value ?? [];
  const repos = [...new Map(list.map((w) => [w.repositoryId, w.repository])).entries()];
  const [repoId, setRepoId] = useState<number | null>(null);
  const repositoryId = repoId ?? repos[0]?.[0] ?? null;
  const inRepo = list.filter((w) => w.repositoryId === repositoryId);
  const [picked, setPicked] = useState<string | null>(null);
  const workflow = inRepo.find((w) => workflowKey(w) === picked) ?? inRepo[0] ?? null;
  const [vcpus, setVcpus] = useState<number>(
    sizes.find((size) => size.vcpus === 4)?.vcpus ?? sizes[0]!.vcpus,
  );
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    if (!workflow) return;
    setStarting(true);
    setError(null);
    try {
      const { id } = await startEvaluation({
        repositoryId: workflow.repositoryId,
        workflowPath: workflow.path,
        workflowName: workflow.workflow ?? undefined,
        provider,
        vcpus,
      });
      await navigate({
        to: "/providers/$provider/evaluate",
        params: { provider },
        search: { id },
      });
    } catch (caught) {
      setError(errorText(caught));
      setStarting(false);
    }
  }

  if (workflows.value === undefined)
    return workflows.error ? (
      <p className="text-sm text-destructive">{workflows.error}</p>
    ) : (
      <p className="text-sm text-muted-foreground">Loading your workflows…</p>
    );
  if (list.length === 0 && !importing)
    return (
      <p className="max-w-3xl rounded-xl border border-dashed bg-card px-4 py-6 text-sm text-muted-foreground">
        No workflows ran in this workspace's repos in the last 14 days. Once one runs, you can
        evaluate {name} on it here.
      </p>
    );

  return (
    <div className="grid max-w-3xl gap-6">
      {history.value?.state === "failed" && (
        <p className="text-sm text-muted-foreground">
          GitHub didn't send all of your recent runs, so some workflows may be missing until they
          run again.
        </p>
      )}
      {active && active.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card px-4 py-3 text-sm">
          <LoaderCircleIcon aria-hidden className="size-4 animate-spin text-run" />
          <span className="flex-1">
            {active[0]!.repository} · {active[0]!.workflow ?? workflowFile(active[0]!.workflowPath)}{" "}
            is being evaluated on {name}.
          </span>
          <Button variant="outline" size="sm" asChild>
            <Link
              to="/providers/$provider/evaluate"
              params={{ provider }}
              search={{ id: active[0]!.id }}
            >
              View
            </Link>
          </Button>
        </div>
      )}

      <div className="flex flex-wrap gap-4">
        <Field label="Repository">
          <Select
            value={String(repositoryId)}
            onValueChange={(value) => {
              setRepoId(Number(value));
              setPicked(null);
            }}
          >
            <SelectTrigger className="w-72">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {repos.map(([id, fullName]) => (
                <SelectItem key={id} value={String(id)}>
                  {fullName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Machine">
          <Select value={String(vcpus)} onValueChange={(value) => setVcpus(Number(value))}>
            <SelectTrigger className="w-72">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sizes.map((size) => (
                <SelectItem key={size.vcpus} value={String(size.vcpus)}>
                  {size.vcpus} vCPU Linux ·{" "}
                  <span className="font-mono text-xs text-muted-foreground">{size.label}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      <Field label="Workflow" hint="Every job in it runs, with its steps unchanged.">
        <div role="radiogroup" className="overflow-hidden rounded-xl border bg-card">
          {inRepo.map((w) => {
            const on = workflow && workflowKey(w) === workflowKey(workflow);
            return (
              <button
                key={workflowKey(w)}
                type="button"
                role="radio"
                aria-checked={!!on}
                onClick={() => setPicked(workflowKey(w))}
                className={cn(
                  "flex w-full items-center gap-3 border-b px-4 py-3 text-left text-sm last:border-0",
                  on ? "bg-raised-2" : "hover:bg-raised",
                )}
              >
                <span
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded-full border",
                    on && "border-foreground",
                  )}
                >
                  {on && <span className="size-2 rounded-full bg-foreground" />}
                </span>
                <WorkflowIcon aria-hidden className="size-4 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{w.workflow ?? workflowFile(w.path)}</span>{" "}
                  <span className="font-mono text-xs text-muted-foreground">
                    {workflowFile(w.path)}
                  </span>
                </span>
                {!(w.runs === 0 && importing) && (
                  <span className="hidden text-muted-foreground tabular-nums sm:inline">
                    {plural(w.runs, "run")} in 14 days
                    {w.medianMs !== null && ` · typically ${clock(w.medianMs)}`}
                  </span>
                )}
                {w.relayed === false && (
                  <span title="Its jobs don't go through a relay yet">
                    <TriangleAlertIcon aria-label="Not routed" className="size-4 text-run" />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </Field>

      {workflow &&
        (workflow.relayed !== false ? (
          <Plan provider={provider} workflow={workflow} />
        ) : (
          <RouteFirst workflow={workflow} />
        ))}

      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={!workflow || workflow.relayed === false || !editable || starting}
          onClick={() => void start()}
        >
          {starting ? <LoaderCircleIcon className="animate-spin" /> : <PlayIcon />}
          Start {EVALUATION_RUNS} runs
        </Button>
        <span className="text-sm text-muted-foreground">
          {editable
            ? `The runs bill to your ${name} account.`
            : "Only owners and admins can start an evaluation."}
        </span>
      </div>
    </div>
  );
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="grid gap-2">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

function Plan({ provider, workflow }: { provider: string; workflow: EvaluationWorkflow }) {
  const { name } = providerInfo(provider);
  return (
    <div className="grid gap-3 rounded-xl border bg-card p-4 text-sm">
      {workflow.medianMs !== null && (
        <div className="flex gap-2">
          <ClockIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-run" />
          <span>
            <span className="font-medium">
              Takes about {about(workflow.medianMs * EVALUATION_RUNS)}
            </span>
            <span className="text-muted-foreground">
              {" "}
              · {EVALUATION_RUNS} runs of about {about(workflow.medianMs)}. You can leave and come
              back.
            </span>
          </span>
        </div>
      )}
      <ul className="grid gap-2 text-muted-foreground">
        <li className="flex gap-2">
          <GitBranchIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>Runs on {name} from the default branch. Nothing in the repo changes.</span>
        </li>
        <li className="flex gap-2">
          <RotateCcwIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>Same commit each time: cold cache first, then warm.</span>
        </li>
        <li className="flex gap-2">
          <WorkflowIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            Compared with its last {Math.min(workflow.baselineRuns, 20) || 20} passing runs.
          </span>
        </li>
      </ul>
      {!workflow.dispatched && (
        <p className="border-t pt-3 text-muted-foreground">
          If it can't be started on demand yet, the next step shows the line to add.
        </p>
      )}
    </div>
  );
}

function RouteFirst({ workflow }: { workflow: EvaluationWorkflow }) {
  const title = workflow.workflow ?? workflowFile(workflow.path);
  const { copied, copy } = useCopy(routePrompt(workflow.repository, null, false));
  return (
    <div className="grid gap-3 rounded-xl border border-run-edge bg-run/10 p-4 text-sm">
      <div className="flex items-start gap-2">
        <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-run" />
        <div className="grid gap-1">
          <span className="font-medium">{title}'s jobs don't go through RelayRunner yet</span>
          <span className="text-muted-foreground">
            An evaluation steers each job through its relay, so route the workflow first. Paste the
            prompt into your coding agent, or follow the Router's setup. Today's runner stays the
            relay's only choice, so where jobs run doesn't change. This page picks up once a run
            with relay jobs comes in.
          </span>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy prompt for your agent"}
        </Button>
        <Button size="sm" variant="outline" asChild>
          <Link to="/router">Router setup</Link>
        </Button>
      </div>
    </div>
  );
}

// ---- One evaluation ------------------------------------------------------------------------------

function EvaluationView({
  id,
  provider,
  editable,
}: {
  id: string;
  provider: string;
  editable: boolean;
}) {
  const [refresh, setRefresh] = useState(0);
  const load = () => getEvaluation(id);
  const [polling, setPolling] = useState(true);
  const { value: report, error } = usePolled(load, polling, [id, refresh]);
  useEffect(() => {
    if (report && !ACTIVE_STATES.includes(report.state)) setPolling(false);
  }, [report]);
  if (!report)
    return (
      <>
        <EvaluateHeader provider={provider} />
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
      </>
    );
  const again = () => setRefresh((n) => n + 1);
  // Still waiting on a dispatch, the evaluation is part of setup; once it runs there's no going
  // back through the steps, so they give way to the run's details and what to do next.
  if (report.state === "waiting")
    return (
      <>
        <EvaluateHeader provider={provider} />
        <EvaluateStepper at={EVALUATE_STEP.choose} provider={provider} />
        <NoDispatch report={report} editable={editable} onChange={again} />
      </>
    );
  return (
    <>
      <EvaluateHeader provider={provider} report={report} actions={<NextSteps report={report} />} />
      <Results report={report} editable={editable} onChange={again} />
    </>
  );
}

/** What to do once an evaluation has finished or stopped: nothing while it runs. */
function NextSteps({ report }: { report: EvaluationReport }) {
  if (ACTIVE_STATES.includes(report.state)) return null;
  const { name } = providerInfo(report.provider);
  // Stopped before any run finished: nothing to add to the Router on.
  const empty =
    (report.state === "failed" || report.state === "cancelled") &&
    !report.attempts.some((a) => a.status === "done");
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" asChild>
        <Link to="/providers/$provider/evaluate" params={{ provider: report.provider }}>
          <RotateCcwIcon />
          Evaluate another workflow
        </Link>
      </Button>
      {!empty && (
        <Button asChild>
          <Link to="/router">
            Add {name} to Router
            <ArrowRightIcon />
          </Link>
        </Button>
      )}
    </div>
  );
}

function RunMeta({ report }: { report: EvaluationReport }) {
  const url = runUrl(report);
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <WorkflowIcon aria-hidden className="size-4" />
        <span>
          {report.repository} · {report.workflow ?? workflowFile(report.workflowPath)}
        </span>
      </span>
      <span className="flex items-center gap-1.5">
        <GitBranchIcon aria-hidden className="size-4" />
        {report.ref}
      </span>
      <span className="font-mono text-[13px]">{report.label}</span>
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 hover:text-foreground"
        >
          Run on GitHub
          <ArrowUpRightIcon aria-hidden className="size-3.5" />
        </a>
      )}
    </div>
  );
}

function NoDispatch({
  report,
  editable,
  onChange,
}: {
  report: EvaluationReport;
  editable: boolean;
  onChange: () => void;
}) {
  const title = report.workflow ?? workflowFile(report.workflowPath);
  const [busy, setBusy] = useState(false);
  const act = (call: () => Promise<unknown>) => async () => {
    setBusy(true);
    await call().catch(() => undefined);
    setBusy(false);
    onChange();
  };
  return (
    <div className="grid max-w-3xl gap-6">
      <RunMeta report={report} />
      <div className="grid gap-3 rounded-xl border border-run-edge bg-run/10 p-4 text-sm">
        <div className="flex items-start gap-2">
          <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-run" />
          <div className="grid gap-1">
            <span className="font-medium">{title} can't be started on demand yet</span>
            <span className="text-muted-foreground">
              Add <code className="font-mono text-[13px]">workflow_dispatch</code> to its{" "}
              <code className="font-mono text-[13px]">on:</code> triggers on {report.ref}. Nothing
              else about the workflow changes. The runs start on their own after the next push to{" "}
              {report.ref} that runs it.
            </span>
          </div>
        </div>
        <CodeBlock
          code={`on:\n  workflow_dispatch:\n  # …the triggers it already has`}
          lang="yaml"
          className="rounded-lg"
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild>
          <a
            href={editUrl(report.repository, report.ref, report.workflowPath)}
            target="_blank"
            rel="noreferrer"
          >
            Edit {workflowFile(report.workflowPath)} on GitHub
            <ArrowUpRightIcon className="size-3.5" />
          </a>
        </Button>
        {editable && (
          <>
            <Button
              variant="outline"
              disabled={busy}
              onClick={act(() => retryEvaluation(report.id))}
            >
              Try again now
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={act(() => cancelEvaluation(report.id))}
            >
              Cancel
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/** "25 min", "1 h 5 min" or "under a minute": a run's or an evaluation's length, for "about …". */
function about(ms: number) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under a minute";
  const h = Math.floor(minutes / 60);
  return h ? `${h} h${minutes % 60 ? ` ${minutes % 60} min` : ""}` : `${minutes} min`;
}

// ---- Results -------------------------------------------------------------------------------------

const total = (split: Split) => split.waitMs + split.runMs;

function change(from: number | null, to: number | null) {
  if (!from || to === null) return null;
  const pct = Math.round(((to - from) / from) * 100);
  return {
    pct,
    text: pct === 0 ? "Same" : pct < 0 ? `${-pct}% faster` : `${pct}% slower`,
  };
}

/** Dollars to the cent, or a tenth of a cent under a dime, so small runs don't all read $0.01. */
function usd(value: number | null) {
  if (value === null) return "—";
  return `$${value.toFixed(value > 0 && value < 0.1 ? 3 : 2)}`;
}

/** "16% more than", "Same as" or "16% less than" today, or null when either cost is unknown. */
function costChange(from: number | null, to: number | null) {
  if (from === null || to === null) return null;
  if (from === 0) return to === 0 ? "Same as" : null;
  const pct = Math.round(((to - from) / from) * 100);
  return pct === 0 ? "Same as" : pct < 0 ? `${-pct}% less than` : `${pct}% more than`;
}

function costDetail(name: string, runUsd: number | null, todayUsd: number | null) {
  if (runUsd === null) return `No list price for ${name}`;
  if (todayUsd === null) return "Today's runners have no list price";
  const vs = costChange(todayUsd, runUsd);
  return vs ? `${vs} ${usd(todayUsd)} today` : `Today ${usd(todayUsd)}`;
}

/**
 * One evaluation, from its first run to the comparison: the numbers fill in as runs finish, the
 * run going now shows its jobs, and the rest wait in line. Stopping keeps the runs that finished.
 */
export function Results({
  report,
  editable,
  onChange,
  preview,
}: {
  report: EvaluationReport;
  editable: boolean;
  onChange: () => void;
  /** A sample shown before sign-in (routes/evaluate.$provider.tsx): no actions or fine print. */
  preview?: boolean;
}) {
  const { name } = providerInfo(report.provider);
  const active = ACTIVE_STATES.includes(report.state);
  const stopped = report.state === "failed" || report.state === "cancelled";
  const finished = report.attempts.filter((a) => a.status === "done").length;
  // The run going now, or the one GitHub is about to start.
  const current = active ? report.attempts.find((a) => a.status !== "done") : undefined;
  const { bar } = providerStyle(report.provider);
  const warm = change(report.baseline.medianMs, report.warm.ms);
  const cold = change(report.baseline.medianMs, report.cold.ms);
  const runUsd = report.warm.usd ?? report.cold.usd;
  // Stopped or failed before every run finished: the numbers come from the runs that did.
  const partial = stopped ? finished : null;
  // Stopped before any run finished: nothing to show but how to start again.
  const empty = stopped && finished === 0;
  const ran = partial ?? (active ? finished : report.runs);
  const hasWarm = report.warm.ms !== null;
  const showWarm = hasWarm || active;
  const warmRuns = ran > 2 ? `runs 2–${ran}` : "run 2";
  const maxJob = Math.max(
    1,
    ...report.jobs.flatMap((j) => [j.baseline, j.cold, j.warm].flatMap((s) => (s ? total(s) : []))),
  );
  return (
    <div className="grid gap-6">
      {/* The signed-in page shows the run's details in its header (EvaluateHeader). */}
      {preview && <RunMeta report={report} />}

      {!active && <Dated report={report} />}
      {active && (
        <Progress report={report} finished={finished} editable={editable} onChange={onChange} />
      )}
      {stopped && (
        <div
          className={cn(
            "flex items-start gap-2 rounded-xl border bg-card px-4 py-3 text-sm",
            report.state === "failed" && "border-destructive/40",
          )}
        >
          {report.state === "failed" ? (
            <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
          ) : (
            <SquareIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          )}
          <span>
            {report.state === "failed"
              ? `Stopped: ${report.error ?? "a run failed."}`
              : finished === 0
                ? "Stopped before run 1 finished."
                : `Stopped after ${finished} of ${report.runs} runs.`}{" "}
            <span className="text-muted-foreground">
              {finished === 0
                ? "No run finished, so there's nothing to compare yet."
                : finished === 1
                  ? "The numbers below are run 1's, with an empty cache; a warm number needs run 2."
                  : `The numbers below come from those ${finished}. More runs would give steadier numbers.`}
            </span>
          </span>
        </div>
      )}

      {!empty && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label="Warm run"
            value={clock(report.warm.ms)}
            detail={
              warm
                ? `${warm.text} than ${clock(report.baseline.medianMs)} today`
                : partial !== null
                  ? "Needs run 2"
                  : active
                    ? "After run 2"
                    : "Median of runs 2 on"
            }
          />
          <StatTile
            label="Cold run"
            value={clock(report.cold.ms)}
            detail={
              cold
                ? `${cold.text} · run 1, empty cache`
                : active
                  ? "After run 1"
                  : "Run 1, empty cache"
            }
          />
          <StatTile
            label="Cost per run"
            value={usd(runUsd)}
            detail={
              finished === 0 && active
                ? `After run 1 · today ${usd(report.baseline.usd)}`
                : costDetail(name, runUsd, report.baseline.usd)
            }
          />
          <StatTile
            label="Waiting for a runner"
            value={clock(report.warm.waitMs ?? report.cold.waitMs)}
            detail={
              finished === 0 && active
                ? `After run 1 · today ${clock(report.baseline.waitMs)}`
                : `Median per job · today ${clock(report.baseline.waitMs)}`
            }
          />
        </div>
      )}

      {!empty && <RunsChart report={report} current={current?.attempt ?? null} />}

      {current && <LiveRun report={report} attempt={current} />}

      {finished > 0 && (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-3 pb-2">
            <h3 className="font-semibold">By job</h3>
            <span className="flex items-center gap-4 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="inline-block size-2.5 rounded-[3px] bg-run/60" />
                Waiting for a runner
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block size-2.5 rounded-[3px] bg-ink-2" />
                <span className={cn("-ml-1 inline-block size-2.5 rounded-[3px]", bar)} />
                Running
              </span>
            </span>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-y text-left text-xs text-muted-foreground">
                <th className="px-4 py-2 font-medium">Job</th>
                <th className="px-4 py-2 font-medium">Today</th>
                <th className="px-4 py-2 font-medium">{name}, run 1 (cold)</th>
                {showWarm && (
                  <th className="px-4 py-2 font-medium">
                    {name}, {active ? `runs 2–${report.runs}` : warmRuns} (warm)
                  </th>
                )}
                <th className="px-4 py-2 text-right font-medium">
                  {hasWarm ? "Warm" : "Cold"} vs today
                </th>
              </tr>
            </thead>
            <tbody>
              {report.jobs.map((job) => {
                const ours = hasWarm ? job.warm : job.cold;
                const delta = change(job.baseline && total(job.baseline), ours && total(ours));
                return (
                  <tr key={job.name} className="border-b last:border-0">
                    <td className="px-4 py-3 font-medium whitespace-nowrap">
                      {job.name}
                      {!job.onProvider && (
                        <span className="block text-xs font-normal text-muted-foreground">
                          Not on {name}: no relay
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <SplitCell split={job.baseline} max={maxJob} barClass="bg-ink-2" />
                    </td>
                    <td className="px-4 py-3">
                      <SplitCell split={job.cold} max={maxJob} barClass={bar} />
                    </td>
                    {showWarm && (
                      <td className="px-4 py-3">
                        <SplitCell
                          split={job.warm}
                          max={maxJob}
                          barClass={bar}
                          pending={active ? "After run 2" : undefined}
                        />
                      </td>
                    )}
                    <td
                      className={cn(
                        "px-4 py-3 text-right whitespace-nowrap tabular-nums",
                        delta && delta.pct < 0 ? "text-go" : "text-muted-foreground",
                      )}
                    >
                      {delta?.text ?? "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {finished > 0 && !preview && (
        <p className="max-w-3xl text-xs text-muted-foreground">
          Today is the median of the workflow's last {plural(report.baseline.runs, "passing run")}{" "}
          on {report.ref} over 14 days, on whatever runners they used and at whatever commit each
          ran. {name}'s runs ran back to back on one commit, so caches were warmer than on a typical
          day. {hasWarm && `Warm is the median of ${warmRuns}. `}Costs are list prices: each job's
          minutes, rounded up, at its runner's price per minute, with your own machines free. Free
          minutes, plan fees and discounts aren't counted.
        </p>
      )}
    </div>
  );
}

/**
 * An evaluation past RECENT_DAYS: still readable from its link, but the provider's real runs are the
 * better guide by now, so point there.
 */
function Dated({ report }: { report: EvaluationReport }) {
  const age = Date.now() - report.createdAt;
  if (age < RECENT_DAYS * 86_400_000) return null;
  const { name } = providerInfo(report.provider);
  const weeks = Math.floor(age / (7 * 86_400_000));
  const routed = report.routedRuns ?? 0;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card px-4 py-3 text-sm">
      <ClockIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        {routed > 0
          ? `From ${weeks} weeks ago. ${name} has run this workflow ${plural(routed, "time")} since.`
          : `From ${weeks} weeks ago. These numbers may be out of date.`}
      </span>
      {routed > 0 ? (
        <Button variant="outline" size="sm" asChild>
          <Link
            to="/performance/workflow"
            search={{ repo: report.repositoryId, workflow: report.workflow ?? undefined }}
          >
            See it on Performance
            <ArrowRightIcon />
          </Link>
        </Button>
      ) : (
        <Button variant="outline" size="sm" asChild>
          <Link to="/providers/$provider/evaluate" params={{ provider: report.provider }}>
            <RotateCcwIcon />
            Evaluate again
          </Link>
        </Button>
      )}
    </div>
  );
}

/** Time left, and the Skip and Stop buttons, while the runs go. */
function Progress({
  report,
  finished,
  editable,
  onChange,
}: {
  report: EvaluationReport;
  finished: number;
  editable: boolean;
  onChange: () => void;
}) {
  // A run's length: the provider's own once one has finished, else how long it takes today.
  const perRun = report.warm.ms ?? report.cold.ms ?? report.baseline.medianMs;
  const left = perRun !== null ? perRun * (report.runs - finished) : null;
  const [busy, setBusy] = useState(false);
  const act = (call: () => Promise<unknown>) => () => {
    setBusy(true);
    void call().then(onChange, onChange);
  };
  return (
    <div className="grid gap-3 rounded-xl border bg-card px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex min-w-64 flex-1 items-start gap-2">
          <ClockIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-run" />
          <div className="grid gap-0.5">
            <span className="font-medium">
              {left !== null ? `About ${about(left)} left` : "Working out the time left"}
              <span className="font-normal text-muted-foreground">
                {" "}
                · run {Math.min(finished + 1, report.runs)} of {report.runs}
                {perRun !== null && `, about ${about(perRun)} each`}
              </span>
            </span>
            <span className="text-muted-foreground">
              {finished === 0
                ? "The numbers below fill in as runs finish. You can leave; the runs carry on."
                : `${plural(finished, "run")} in. Stop whenever you've seen enough; finished runs are kept.`}
            </span>
          </div>
        </div>
        {editable && (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={act(() => cancelEvaluation(report.id))}
            >
              <SquareIcon />
              {finished > 0 ? `Stop at ${plural(finished, "run")}` : "Stop"}
            </Button>
          </div>
        )}
      </div>
      <div className="flex gap-1">
        {report.attempts.map((a) => (
          <span
            key={a.attempt}
            className={cn(
              "h-1.5 flex-1 rounded-full",
              a.status === "done"
                ? providerStyle(report.provider).bar
                : a.attempt === finished + 1
                  ? "animate-pulse bg-run/60"
                  : "bg-raised-2",
            )}
          />
        ))}
      </div>
    </div>
  );
}

/** The run going now: its jobs as they queue, run and finish. */
function LiveRun({ report, attempt }: { report: EvaluationReport; attempt: Attempt }) {
  const url = report.runId ? runUrl(report, attempt.attempt) : null;
  return (
    <div className="rounded-xl border bg-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-3 pb-2">
        <h3 className="flex items-center gap-2 font-semibold">
          <LoaderCircleIcon aria-hidden className="size-4 animate-spin text-run" />
          Run {attempt.attempt} now
          <span className="font-normal text-muted-foreground">
            {attempt.attempt === 1 ? "Cold cache" : "Warm"}
          </span>
        </h3>
        {url && attempt.status !== "waiting" && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            On GitHub
            <ArrowUpRightIcon aria-hidden className="size-3" />
          </a>
        )}
      </div>
      {attempt.jobs.length === 0 ? (
        <p className="border-t px-4 py-3 text-sm text-muted-foreground">
          {report.runId
            ? `Waiting for GitHub to start run ${attempt.attempt}. Jobs show up here once runners pick them up.`
            : "Asking GitHub to start the workflow."}
        </p>
      ) : (
        <ul className="grid gap-2 border-t px-4 py-3 text-sm">
          {attempt.jobs.map((job) => (
            <li key={job.name} className="flex items-center gap-2">
              {job.status === "done" && (
                <CheckIcon aria-hidden className="size-3.5 text-muted-foreground" />
              )}
              {job.status === "running" && (
                <LoaderCircleIcon aria-hidden className="size-3.5 animate-spin text-run" />
              )}
              {job.status === "queued" && (
                <CircleDashedIcon aria-hidden className="size-3.5 text-muted-foreground" />
              )}
              <span className="flex-1">{job.name}</span>
              <span className="text-muted-foreground tabular-nums">
                {job.split
                  ? clock(job.split.waitMs + job.split.runMs)
                  : job.status === "queued"
                    ? "Queued"
                    : "Running"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SplitCell({
  split,
  max,
  barClass,
  pending,
}: {
  split: Split | null;
  max: number;
  barClass: string;
  /** Shown instead of a dash while the number is still to come. */
  pending?: string;
}) {
  if (!split) return <span className="text-muted-foreground">{pending ?? "—"}</span>;
  return (
    <div className="grid min-w-32 gap-1.5">
      <span className="flex items-baseline justify-between gap-2 tabular-nums">
        <span>{clock(total(split))}</span>
        <span className="text-xs text-muted-foreground">wait {clock(split.waitMs)}</span>
      </span>
      <span className="flex h-2 w-full overflow-hidden rounded-full bg-raised-2">
        <span className="h-full bg-run/60" style={{ width: `${(split.waitMs / max) * 100}%` }} />
        <span
          className={cn("h-full", barClass)}
          style={{ width: `${(split.runMs / max) * 100}%` }}
        />
      </span>
    </div>
  );
}

// Small, fixed nudges so the silhouettes of runs still to come don't line up exactly.
const WOBBLE = [1, 0.93, 1.06, 0.95, 1.07];

/**
 * How tall to draw each run that hasn't finished, in ms: about as long as the run before it. Run 1
 * guesses a little under today's median, and run 2, the first warm one, a little under run 1.
 */
function silhouettes(report: EvaluationReport) {
  const heights: number[] = [];
  let previous: number | null = null;
  for (const a of report.attempts) {
    if (a.ms !== null) {
      previous = a.ms;
      heights.push(a.ms);
      continue;
    }
    const guess: number =
      previous === null
        ? (report.baseline.medianMs ?? 300_000) * 0.92
        : a.attempt === 2
          ? previous * 0.85
          : previous * WOBBLE[a.attempt % WOBBLE.length]!;
    heights.push(guess);
    previous = guess;
  }
  return heights;
}

function RunsChart({ report, current }: { report: EvaluationReport; current: number | null }) {
  const notRunLabel = report.state === "cancelled" || report.state === "failed" ? "Not run" : null;
  const { name } = providerInfo(report.provider);
  const { bar } = providerStyle(report.provider);
  const baseline = report.baseline.medianMs;
  const heights = current !== null ? silhouettes(report) : [];
  const max =
    Math.max(baseline ?? 0, ...report.attempts.map((a) => a.ms ?? 0), ...heights, 1) * 1.15;
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">Each run, start to finish</h3>
        <span className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className={cn("inline-block size-2.5 rounded-[3px]", bar)} />
            {name}
          </span>
          {baseline !== null && (
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-0 w-4 border-t-2 border-dashed border-ink-2" />
              Today's median
            </span>
          )}
        </span>
      </div>
      <div className="relative flex h-44 items-end gap-4 border-b pl-1 sm:gap-8">
        {baseline !== null && (
          <span
            className="absolute inset-x-0 border-t-2 border-dashed border-ink-2"
            style={{ bottom: `${(baseline / max) * 100}%` }}
          >
            {/* The median's value on the line itself, at the right end, clear of the bars. */}
            <span className="absolute right-0 bottom-1 rounded bg-card px-1.5 text-xs font-medium text-muted-foreground tabular-nums">
              Today {clock(baseline)}
            </span>
          </span>
        )}
        {report.attempts.map((a) => (
          <div key={a.attempt} className="flex h-full flex-1 flex-col items-center justify-end">
            {a.status !== "done" && current !== null ? (
              // A run still to come: a dashed silhouette about as tall as the run before it.
              <span
                className={cn(
                  "flex w-full max-w-14 items-start justify-center rounded-t-md border-2 border-b-0 border-dashed pt-2",
                  a.attempt === current ? "border-run/60 bg-run/10" : "border-ink-2/40 bg-raised",
                )}
                style={{ height: `${((heights[a.attempt - 1] ?? 0) / max) * 100}%` }}
              >
                {a.attempt === current && (
                  <LoaderCircleIcon aria-hidden className="size-4 animate-spin text-run" />
                )}
              </span>
            ) : (
              <span
                className={cn("w-full max-w-14 rounded-t-md", bar, a.attempt === 1 && "opacity-50")}
                style={{ height: `${((a.ms ?? 0) / max) * 100}%` }}
              />
            )}
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-4 pl-1 text-center text-xs text-muted-foreground sm:gap-8">
        {report.attempts.map((a) => (
          <span key={a.attempt} className="flex-1">
            {/* Under the axis, so a bar near the median line never hides its time. */}
            <span className="block text-sm font-medium text-foreground tabular-nums">
              {a.ms !== null
                ? clock(a.ms)
                : a.attempt === current
                  ? a.status === "waiting"
                    ? "Starting"
                    : "Running"
                  : notRunLabel !== null
                    ? notRunLabel
                    : current !== null
                      ? "Queued"
                      : "—"}
            </span>
            {a.usd !== null && (
              <span className="block text-foreground tabular-nums">{usd(a.usd)}</span>
            )}
            Run {a.attempt}
            <br />
            {a.attempt === 1 ? "Cold cache" : "Warm"}
          </span>
        ))}
      </div>
    </div>
  );
}
