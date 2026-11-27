// The steps before an evaluation runs: connect the provider, pick a workflow, and dispatch it.
import { providerPlans } from "@relayrunner/providers";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
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
  type EvaluationWorkflow,
  evaluationSizes,
  EVALUATION_RUNS,
  getEvaluationWorkflows,
  getRunHistory,
  listEvaluations,
  startEvaluation,
} from "@/lib/evaluations";
import { clock, plural } from "@/lib/job-times";
import { providerInfo } from "@/lib/provider-catalog";
import { getProviderApps } from "@/lib/provider-apps";
import { routePrompt } from "@/lib/route-repo";
import { useCopy } from "@/lib/use-copy";
import { cn } from "@/lib/utils";
import { EVALUATE_STEP, EvaluateStepper } from "@/components/evaluate-stepper";
import { usePolled, workflowFile, about } from "@/features/evaluations/shared";

// ---- Setup: connect, then choose -----------------------------------------------------------------

export function Setup({
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
