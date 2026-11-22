// Evaluate a provider: run one workflow on it five times and compare with how it runs today
// (apps/api/src/evaluations.ts). Without `?id` it walks through connecting the provider and
// picking a workflow; with one it shows that evaluation's runs, then the comparison.
import { providerPlans } from "@relayrunner/providers";
import { createFileRoute, Link, notFound, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpRightIcon,
  CheckIcon,
  CircleDashedIcon,
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
import { authDisabled } from "@/lib/auth-client";
import {
  ACTIVE_STATES,
  type Attempt,
  cancelEvaluation,
  editUrl,
  type EvaluationReport,
  type EvaluationSummary,
  type EvaluationWorkflow,
  evaluationSizes,
  EVALUATION_RUNS,
  getEvaluation,
  getEvaluationWorkflows,
  listEvaluations,
  retryEvaluation,
  runUrl,
  sampleEvaluation,
  SAMPLE_WORKFLOWS,
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

type EvaluateSearch = { id?: string; sample?: string };

export const Route = createFileRoute("/_authed/_workspace/providers/$provider_/evaluate")({
  validateSearch: (search: Record<string, unknown>): EvaluateSearch => ({
    id: typeof search.id === "string" && search.id ? search.id : undefined,
    sample: typeof search.sample === "string" ? search.sample : undefined,
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
  const { id, sample } = Route.useSearch();
  const { current } = Route.useRouteContext();
  const info = providerInfo(provider);
  usePageTitle(`Evaluate ${info.name}`);
  const { icon, tile } = providerStyle(provider);
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
      <header className="flex min-w-0 items-center gap-3.5">
        <span className={cn(TILE, "size-12 rounded-[10px] [&_svg]:scale-150", tile)}>{icon}</span>
        <div className="grid min-w-0 gap-1">
          <h1 className="text-2xl leading-tight font-bold tracking-[-0.01em]">
            Evaluate {info.name}
          </h1>
          <p className="text-muted-foreground">
            Run one of your workflows on {info.name} {EVALUATION_RUNS} times and compare it with how
            it runs today. Your Router isn't used or changed.
          </p>
        </div>
      </header>
      {id || sample?.startsWith("eval") ? (
        <EvaluationView
          key={id ?? sample}
          id={id ?? ""}
          sample={sample}
          provider={provider}
          editable={canManage(current.role)}
        />
      ) : (
        <Setup
          provider={provider}
          workspaceId={current.workspace.id}
          editable={canManage(current.role)}
          sample={sample}
        />
      )}
    </section>
  );
}

const STEPS = ["Connect", "Choose a workflow", `${EVALUATION_RUNS} runs`, "Compare"];

function Stepper({ at, provider }: { at: number; provider: string }) {
  const steps = STEPS.map((label, i) =>
    i === 0 ? `${label} ${providerInfo(provider).name}` : label,
  );
  return (
    <ol className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
      {steps.map((label, i) => (
        <li key={label} className="flex items-center gap-3">
          <span
            className={cn(
              "flex items-center gap-2",
              i > at ? "text-muted-foreground" : "font-medium",
            )}
          >
            <span
              className={cn(
                "flex size-5 items-center justify-center rounded-full border text-xs tabular-nums",
                i < at && "border-go-edge bg-go-soft text-go",
                i === at && "border-foreground bg-foreground text-background",
              )}
            >
              {i < at ? <CheckIcon aria-label="Done" className="size-3" /> : i + 1}
            </span>
            {label}
          </span>
          {i < steps.length - 1 && <span aria-hidden className="h-px w-8 bg-border" />}
        </li>
      ))}
    </ol>
  );
}

/** Calls `load` now and every POLL_MS while `polling`, keeping the last answer. */
function usePolled<T>(load: () => Promise<T>, polling: boolean, deps: unknown[]) {
  const [value, setValue] = useState<T | null>(null);
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
  sample,
}: {
  provider: string;
  workspaceId: string;
  editable: boolean;
  sample?: string;
}) {
  // Null: GitHub can't tell (a personal account), so it isn't asked.
  const apps = usePolled(
    () =>
      authDisabled
        ? Promise.resolve(sample === "connect" ? [] : null)
        : getProviderApps(workspaceId),
    true,
    [workspaceId],
  );
  const loaded = apps.value !== null || apps.error !== null || authDisabled;
  const connected = apps.value === null || apps.value.includes(provider as never);
  if (!loaded) return <Stepper at={0} provider={provider} />;
  return (
    <>
      <Stepper at={connected ? 1 : 0} provider={provider} />
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
  const workflows = usePolled(
    () => (authDisabled ? Promise.resolve(SAMPLE_WORKFLOWS) : getEvaluationWorkflows()),
    true,
    [],
  );
  const active = usePolled(
    () => (authDisabled ? Promise.resolve([] as EvaluationSummary[]) : listEvaluations(provider)),
    false,
    [provider],
  ).value?.filter((e) => ACTIVE_STATES.includes(e.state));
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
      const { id } = authDisabled
        ? { id: "" }
        : await startEvaluation({
            repositoryId: workflow.repositoryId,
            workflowPath: workflow.path,
            provider,
            vcpus,
          });
      await navigate({
        to: "/providers/$provider/evaluate",
        params: { provider },
        search: authDisabled ? { sample: "eval-running" } : { id },
      });
    } catch (caught) {
      setError(errorText(caught));
      setStarting(false);
    }
  }

  if (workflows.value === null)
    return workflows.error ? (
      <p className="text-sm text-destructive">{workflows.error}</p>
    ) : (
      <p className="text-sm text-muted-foreground">Loading your workflows…</p>
    );
  if (list.length === 0)
    return (
      <p className="max-w-3xl rounded-xl border border-dashed bg-card px-4 py-6 text-sm text-muted-foreground">
        No workflows ran in this workspace's repos in the last 14 days. Once one runs, you can
        evaluate {name} on it here.
      </p>
    );

  return (
    <div className="grid max-w-3xl gap-6">
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

      <Field
        label="Workflow"
        hint="The whole workflow runs, every job in it. Jobs keep their steps; only where they run changes."
      >
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
                <span className="hidden text-muted-foreground tabular-nums sm:inline">
                  {plural(w.runs, "run")} in 14 days
                  {w.medianMs !== null && ` · typically ${clock(w.medianMs)}`}
                </span>
                {!w.relayed && (
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
        (workflow.relayed ? (
          <Plan provider={provider} workflow={workflow} vcpus={vcpus} />
        ) : (
          <RouteFirst workflow={workflow} />
        ))}

      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={!workflow?.relayed || !editable || starting} onClick={() => void start()}>
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

function Plan({
  provider,
  workflow,
  vcpus,
}: {
  provider: string;
  workflow: EvaluationWorkflow;
  vcpus: number;
}) {
  const { name } = providerInfo(provider);
  const title = workflow.workflow ?? workflowFile(workflow.path);
  return (
    <div className="grid gap-3 rounded-xl border bg-card p-4 text-sm">
      <ul className="grid gap-2 text-muted-foreground">
        <li className="flex gap-2">
          <GitBranchIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            RelayRunner starts {title} on the default branch. Its relay jobs send every job to{" "}
            {name} ({vcpus} vCPU Linux) for this evaluation only; nothing in the repo changes.
          </span>
        </li>
        <li className="flex gap-2">
          <RotateCcwIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            {EVALUATION_RUNS} runs, one after another, on the same commit. The first shows a cold
            cache, the others a warm one.
          </span>
        </li>
        <li className="flex gap-2">
          <WorkflowIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            Compared with {title}'s last {Math.min(workflow.baselineRuns, 20) || 20} passing runs on
            the default branch, wherever they ran.
          </span>
        </li>
      </ul>
      {!workflow.dispatched && (
        <p className="border-t pt-3 text-muted-foreground">
          If {title} can't be started on demand yet, the next step shows the one line to add.
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
  sample,
  provider,
  editable,
}: {
  id: string;
  sample?: string;
  provider: string;
  editable: boolean;
}) {
  const [refresh, setRefresh] = useState(0);
  const load = () => {
    if (!authDisabled) return getEvaluation(id);
    if (sample === "eval-waiting") return Promise.resolve(sampleEvaluation(provider, 0, "waiting"));
    if (sample === "eval-done") return Promise.resolve(sampleEvaluation(provider, EVALUATION_RUNS));
    return Promise.resolve(sampleEvaluation(provider, 2));
  };
  const [polling, setPolling] = useState(true);
  const { value: report, error } = usePolled(load, polling, [id, refresh]);
  useEffect(() => {
    if (report && !ACTIVE_STATES.includes(report.state)) setPolling(false);
  }, [report]);
  if (!report)
    return error ? (
      <p className="text-sm text-destructive">{error}</p>
    ) : (
      <p className="text-sm text-muted-foreground">Loading…</p>
    );
  const again = () => setRefresh((n) => n + 1);
  const finished = report.state === "done";
  return (
    <>
      <Stepper at={report.state === "waiting" ? 1 : finished ? 3 : 2} provider={provider} />
      {report.state === "waiting" ? (
        <NoDispatch report={report} editable={editable} onChange={again} />
      ) : finished ? (
        <Results report={report} />
      ) : (
        <Running report={report} editable={editable} onChange={again} />
      )}
    </>
  );
}

function RunMeta({ report }: { report: EvaluationReport }) {
  const url = runUrl(report);
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <WorkflowIcon aria-hidden className="size-4" />
        <span className="text-foreground">
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

function Running({
  report,
  editable,
  onChange,
}: {
  report: EvaluationReport;
  editable: boolean;
  onChange: () => void;
}) {
  const { name } = providerInfo(report.provider);
  const max = Math.max(report.baseline.medianMs ?? 0, ...report.attempts.map((a) => a.ms ?? 0), 1);
  const stopped = report.state === "failed" || report.state === "cancelled";
  return (
    <div className="grid gap-6">
      <RunMeta report={report} />
      {stopped && (
        <div className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-card px-4 py-3 text-sm">
          <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
          <span>
            {report.state === "cancelled"
              ? "Stopped."
              : `Stopped: ${report.error ?? "a run failed."}`}{" "}
            <span className="text-muted-foreground">Runs that finished are below.</span>
          </span>
        </div>
      )}
      <div className="grid gap-3 lg:grid-cols-[1fr_18rem]">
        <ol className="rounded-xl border bg-card">
          {report.attempts.map((attempt) => (
            <RunRow key={attempt.attempt} attempt={attempt} max={max} report={report} />
          ))}
        </ol>
        <div className="grid content-start gap-3">
          <StatTile
            label="Today"
            value={clock(report.baseline.medianMs)}
            detail={`Median of ${plural(report.baseline.runs, "passing run")}`}
          />
          <StatTile
            label={`So far on ${name}`}
            value={clock(report.warm.ms ?? report.cold.ms)}
            detail={
              report.warm.ms !== null
                ? `Warm · cold ${clock(report.cold.ms)}`
                : report.cold.ms !== null
                  ? "Cold cache"
                  : "Waiting for run 1"
            }
          />
          {!stopped && (
            <>
              <p className="text-xs text-muted-foreground">
                You can leave. The runs carry on, and this page has the comparison when run{" "}
                {report.runs} finishes.
              </p>
              {editable && (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-fit"
                  onClick={() => void cancelEvaluation(report.id).then(onChange, onChange)}
                >
                  Stop
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function RunRow({
  attempt,
  max,
  report,
}: {
  attempt: Attempt;
  max: number;
  report: EvaluationReport;
}) {
  const { status } = attempt;
  const failed = attempt.conclusion !== null && attempt.conclusion !== "success";
  const url = status !== "waiting" ? runUrl(report, attempt.attempt) : null;
  return (
    <li className="grid gap-3 border-b px-4 py-3 last:border-0">
      <div className="flex items-center gap-3 text-sm">
        {status === "done" &&
          (failed ? (
            <TriangleAlertIcon aria-label="Failed" className="size-[18px] text-destructive" />
          ) : (
            <CheckIcon aria-label="Done" className="size-[18px] text-muted-foreground" />
          ))}
        {status === "running" && (
          <LoaderCircleIcon aria-label="Running" className="size-[18px] animate-spin text-run" />
        )}
        {status === "waiting" && (
          <CircleDashedIcon aria-label="Waiting" className="size-[18px] text-muted-foreground" />
        )}
        <span className={cn("w-14 font-medium", status === "waiting" && "text-muted-foreground")}>
          {url ? (
            <a href={url} target="_blank" rel="noreferrer" className="hover:underline">
              Run {attempt.attempt}
            </a>
          ) : (
            `Run ${attempt.attempt}`
          )}
        </span>
        <span className="flex-1 text-muted-foreground">
          {attempt.attempt === 1 ? "Cold cache" : "Warm"}
        </span>
        {attempt.ms !== null && (
          <span className="flex items-center gap-3">
            <span className="hidden h-1.5 w-40 overflow-hidden rounded-full bg-raised-2 sm:block">
              <span
                className={cn("block h-full rounded-full", providerStyle(report.provider).bar)}
                style={{ width: `${(attempt.ms / max) * 100}%` }}
              />
            </span>
            <span className="w-16 text-right tabular-nums">{clock(attempt.ms)}</span>
          </span>
        )}
      </div>
      {status === "running" && attempt.jobs.length > 0 && (
        <ul className="ml-[30px] grid gap-1.5 rounded-lg bg-raised px-3 py-2.5 text-[13px]">
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
                    : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

// ---- Results -------------------------------------------------------------------------------------

const total = (split: Split) => split.waitMs + split.runMs;

function change(from: number | null, to: number | null) {
  if (!from || to === null) return null;
  const pct = Math.round(((to - from) / from) * 100);
  return { pct, text: pct === 0 ? "Same" : pct < 0 ? `${-pct}% faster` : `${pct}% slower` };
}

function Results({ report }: { report: EvaluationReport }) {
  const { name } = providerInfo(report.provider);
  const { bar } = providerStyle(report.provider);
  const warm = change(report.baseline.medianMs, report.warm.ms);
  const cold = change(report.baseline.medianMs, report.cold.ms);
  const maxJob = Math.max(
    1,
    ...report.jobs.flatMap((j) => [j.baseline, j.cold, j.warm].flatMap((s) => (s ? total(s) : []))),
  );
  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <RunMeta report={report} />
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link to="/providers/$provider/evaluate" params={{ provider: report.provider }}>
              <RotateCcwIcon />
              Evaluate another workflow
            </Link>
          </Button>
          <Button asChild>
            <Link to="/router">
              Add {name} to Router
              <ArrowRightIcon />
            </Link>
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Warm run"
          value={clock(report.warm.ms)}
          detail={
            warm
              ? `${warm.text} than ${clock(report.baseline.medianMs)} today`
              : "Median of runs 2 on"
          }
        />
        <StatTile
          label="Cold run"
          value={clock(report.cold.ms)}
          detail={cold ? `${cold.text} · run 1, empty cache` : "Run 1, empty cache"}
        />
        <StatTile
          label="Waiting for a runner"
          value={clock(report.warm.waitMs ?? report.cold.waitMs)}
          detail={`Median per job · today ${clock(report.baseline.waitMs)}`}
        />
        <StatTile
          label="Compared with"
          value={plural(report.baseline.runs, "run")}
          detail={`Passing on ${report.ref}, last 14 days`}
        />
      </div>

      <RunsChart report={report} />

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
              <th className="px-4 py-2 font-medium">
                {name}, runs 2–{report.runs} (warm)
              </th>
              <th className="px-4 py-2 text-right font-medium">Warm vs today</th>
            </tr>
          </thead>
          <tbody>
            {report.jobs.map((job) => {
              const delta = change(
                job.baseline && total(job.baseline),
                job.warm && total(job.warm),
              );
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
                  <td className="px-4 py-3">
                    <SplitCell split={job.warm} max={maxJob} barClass={bar} />
                  </td>
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

      <p className="max-w-3xl text-xs text-muted-foreground">
        Today is the median of the workflow's last {plural(report.baseline.runs, "passing run")} on{" "}
        {report.ref} over 14 days, on whatever runners they used and at whatever commit each ran.{" "}
        {name}'s runs ran back to back on one commit, so caches were warmer than on a typical day.
        Warm is the median of runs 2 to {report.runs}.
      </p>
    </div>
  );
}

function SplitCell({
  split,
  max,
  barClass,
}: {
  split: Split | null;
  max: number;
  barClass: string;
}) {
  if (!split) return <span className="text-muted-foreground">—</span>;
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

function RunsChart({ report }: { report: EvaluationReport }) {
  const { name } = providerInfo(report.provider);
  const { bar } = providerStyle(report.provider);
  const baseline = report.baseline.medianMs;
  const max = Math.max(baseline ?? 0, ...report.attempts.map((a) => a.ms ?? 0), 1) * 1.15;
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
              Today's median, {clock(baseline)}
            </span>
          )}
        </span>
      </div>
      <div className="relative flex h-44 items-end gap-4 border-b pl-1 sm:gap-8">
        {baseline !== null && (
          <span
            aria-hidden
            className="absolute inset-x-0 border-t-2 border-dashed border-ink-2"
            style={{ bottom: `${(baseline / max) * 100}%` }}
          />
        )}
        {report.attempts.map((a) => (
          <div
            key={a.attempt}
            className="flex h-full flex-1 flex-col items-center justify-end gap-1"
          >
            <span className="text-xs tabular-nums">{a.ms !== null ? clock(a.ms) : "—"}</span>
            <span
              className={cn("w-full max-w-14 rounded-t-md", bar, a.attempt === 1 && "opacity-50")}
              style={{ height: `${((a.ms ?? 0) / max) * 100}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-4 pl-1 text-center text-xs text-muted-foreground sm:gap-8">
        {report.attempts.map((a) => (
          <span key={a.attempt} className="flex-1">
            Run {a.attempt}
            <br />
            {a.attempt === 1 ? "Cold cache" : "Warm"}
          </span>
        ))}
      </div>
    </div>
  );
}
