import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  DEFAULT_LIMIT_PERCENT,
  RUNNER_LABELS,
  stepSlot,
  type RunnerKey,
  type RunnerStep,
} from "@relayrunner/runner-order";
import { Link, useRouter } from "@tanstack/react-router";
import {
  CheckIcon,
  ChevronDownIcon,
  GripVerticalIcon,
  MoreHorizontalIcon,
  PlusIcon,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { hasQuota, type AccountUsage } from "@/lib/actions-usage";
import type { Machine } from "@/lib/machines";
import { previewRoute, type StepVerdict } from "@/lib/route-preview";
import { RunnerOrderError, saveRunnerOrder } from "@/lib/runner-order";
import { cn } from "@/lib/utils";

type SaveStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

/** The labels relay.yml's example uses for each provider. */
const EXAMPLE_INPUTS: Record<RunnerKey, string> = {
  machine: "self-hosted",
  github: "ubuntu-latest",
  blacksmith: "blacksmith-2vcpu-ubuntu-2404",
};

/**
 * The runner order as a chain: each step hands a job to the next when it can't take it. Each step
 * says whether the next job would stop there; beside it, the relay.yml inputs the order needs.
 */
export function RunnerOrderEditor({
  workspaceId,
  order,
  isDefault,
  editable,
  machines,
  accounts,
}: {
  workspaceId: string;
  order: { steps: RunnerStep[] };
  isDefault: boolean;
  /** Owners and admins change the order (#134); members read it. The API refuses a member's save. */
  editable: boolean;
  /** The machines' live status, or null while it loads (the Self-hosted step shows no badge). */
  machines: Machine[] | null;
  /** This month's Actions minutes per connected GitHub account (#116). */
  accounts: AccountUsage[];
}) {
  const router = useRouter();
  const [saved, setSaved] = useState({ steps: order.steps, isDefault });
  const [steps, setSteps] = useState<RunnerStep[]>(order.steps);
  const [status, setStatus] = useState<SaveStatus>({ kind: "idle" });
  const dirty = JSON.stringify(steps) !== JSON.stringify(saved.steps);
  const preview = previewRoute(steps, machines, accounts);
  const limits = limitAvailability(accounts);

  function change(next: RunnerStep[]) {
    setSteps(next);
    setStatus({ kind: "idle" });
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  function onDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    const from = steps.findIndex((step) => stepSlot(step) === active.id);
    const to = steps.findIndex((step) => stepSlot(step) === over.id);
    change(arrayMove(steps, from, to));
  }

  async function save() {
    setStatus({ kind: "saving" });
    try {
      const result = await saveRunnerOrder(workspaceId, { steps });
      setSaved({ steps: result.order.steps, isDefault: result.isDefault });
      setStatus({ kind: "saved" });
      // Cached loader data (this page's, the Runners page's) still holds the old order.
      void router.invalidate();
    } catch (error) {
      const message =
        error instanceof RunnerOrderError && error.reason
          ? error.reason
          : "Couldn't save the order. Try again.";
      setStatus({ kind: "error", message });
    }
  }

  const slots = new Set(steps.map(stepSlot));
  // GitHub fits twice: once with a limit, once without.
  const githubSlotFree = !slots.has("github") || (limits.allowed && !slots.has("github:limit"));
  function addStep(key: RunnerKey) {
    const step: RunnerStep =
      key === "github" && slots.has("github")
        ? { key: "github", limit: { percent: DEFAULT_LIMIT_PERCENT } }
        : { key };
    change([...steps, step]);
  }

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-start gap-6">
        <div className="grid min-w-0 flex-[1_1_480px] gap-1.5">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={steps.map(stepSlot)} strategy={verticalListSortingStrategy}>
              <ol className="grid" aria-label="Runner order">
                {steps.map((step, index) => (
                  <StepCard
                    key={stepSlot(step)}
                    step={step}
                    index={index}
                    count={steps.length}
                    verdict={preview.steps[index]}
                    editable={editable}
                    accounts={accounts}
                    limits={limits}
                    slots={slots}
                    onChange={(next) => change(steps.map((s, i) => (i === index ? next : s)))}
                    onMove={(by) => change(arrayMove(steps, index, index + by))}
                    onRemove={() => change(steps.filter((_, i) => i !== index))}
                  />
                ))}
              </ol>
            </SortableContext>
          </DndContext>

          {editable && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-1 justify-self-start text-muted-foreground"
                >
                  <PlusIcon aria-hidden />
                  Add step
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-64">
                <AddItem
                  label={RUNNER_LABELS.machine}
                  note={slots.has("machine") ? "Already in the order" : "Your runners, as one pool"}
                  disabled={slots.has("machine")}
                  onSelect={() => addStep("machine")}
                />
                <AddItem
                  label={RUNNER_LABELS.github}
                  note={
                    !githubSlotFree
                      ? "Already in the order"
                      : slots.has("github")
                        ? "Again, while under a limit"
                        : "GitHub's own runners"
                  }
                  disabled={!githubSlotFree}
                  onSelect={() => addStep("github")}
                />
                <AddItem
                  label={RUNNER_LABELS.blacksmith}
                  note={
                    slots.has("blacksmith")
                      ? "Already in the order"
                      : "Needs Blacksmith's GitHub app"
                  }
                  disabled={slots.has("blacksmith")}
                  onSelect={() => addStep("blacksmith")}
                />
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        <WorkflowPanel steps={steps} />
      </div>

      {(dirty || status.kind !== "idle") && (
        <div
          className={cn(
            "sticky bottom-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-secondary px-4 py-2.5 shadow-lg",
            dirty ? "border-go-edge" : "border-border",
          )}
        >
          <span role="status" className="text-sm">
            {status.kind === "error" ? (
              <span className="text-destructive">{status.message}</span>
            ) : status.kind === "saved" && !dirty ? (
              <span className="text-muted-foreground">Order saved.</span>
            ) : (
              <span className="text-muted-foreground">You changed the runner order.</span>
            )}
          </span>
          {dirty && (
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => change(saved.steps)}>
                Discard
              </Button>
              <Button size="sm" disabled={status.kind === "saving"} onClick={() => void save()}>
                {status.kind === "saving" ? "Saving…" : "Save order"}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AddItem({
  label,
  note,
  disabled,
  onSelect,
}: {
  label: string;
  note: string;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem disabled={disabled} onSelect={onSelect} className="grid gap-0.5">
      <span>{label}</span>
      <span className="text-xs text-muted-foreground">{note}</span>
    </DropdownMenuItem>
  );
}

/**
 * Whether a GitHub step can use a minutes limit: only when some connected account has a quota
 * we know. When none does, `blocked` is the one line saying why and `fix` where to fix it.
 */
type LimitAvailability = { allowed: true } | { allowed: false; blocked: string };

function limitAvailability(accounts: AccountUsage[]): LimitAvailability {
  if (accounts.some(hasQuota)) return { allowed: true };
  if (accounts.length === 0) return { allowed: false, blocked: "Connect a GitHub account first." };
  const reasons = new Set(accounts.map((account) => account.reason));
  if (reasons.has("enterprise"))
    return { allowed: false, blocked: "Needs RelayRunner on your enterprise." };
  if (reasons.has("missing_permission"))
    return { allowed: false, blocked: "Needs billing access to your org." };
  if (reasons.has("sign_in_needed"))
    return { allowed: false, blocked: "Sign in again to share your account's minutes." };
  if (reasons.has("not_read_yet"))
    return { allowed: false, blocked: "Waiting for the first minutes reading." };
  return { allowed: false, blocked: "Your GitHub plan's minutes aren't known." };
}

function StepCard({
  step,
  index,
  count,
  verdict,
  editable,
  accounts,
  limits,
  slots,
  onChange,
  onMove,
  onRemove,
}: {
  step: RunnerStep;
  index: number;
  count: number;
  verdict: StepVerdict | undefined;
  editable: boolean;
  accounts: AccountUsage[];
  limits: LimitAvailability;
  slots: Set<string>;
  onChange: (step: RunnerStep) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: stepSlot(step), disabled: !editable });
  const label = RUNNER_LABELS[step.key];
  const limit = step.key === "github" ? step.limit : undefined;

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("grid", isDragging && "relative z-10")}
    >
      {index > 0 && (
        <div aria-hidden className="flex h-7 items-center gap-2.5 pl-[19px]">
          <span className="h-full w-px bg-border" />
          <span className="text-xs text-muted-foreground">if it can't</span>
        </div>
      )}
      <div
        className={cn("rounded-lg border bg-card", isDragging && "shadow-lg ring-1 ring-ring/40")}
      >
        <div className="flex flex-wrap items-center gap-2.5 py-2.5 pr-2.5 pl-2">
          {editable ? (
            <button
              ref={setActivatorNodeRef}
              type="button"
              aria-label={`Drag ${label} to reorder`}
              className="flex size-7 shrink-0 cursor-grab touch-none items-center justify-center rounded text-[var(--rr-idle)] hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none active:cursor-grabbing"
              {...attributes}
              {...listeners}
            >
              <GripVerticalIcon aria-hidden className="size-4" />
            </button>
          ) : (
            <span className="w-2" />
          )}
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">{label}</h2>
            {verdict?.state === "next" && (
              <span className="rounded-full border border-go-edge bg-go-soft px-2 text-[11.5px] font-semibold text-go">
                Next job
              </span>
            )}
            {verdict?.state === "skipped" && (
              <span
                title={verdict.reason}
                className="rounded-full border px-2 text-[11.5px] text-muted-foreground"
              >
                Skipped
              </span>
            )}
          </div>
          {step.key === "github" && editable ? (
            <GitHubRule
              step={step}
              limits={limits}
              accounts={accounts}
              // Each GitHub rule fits once, so a second GitHub step can't take the other's.
              canLimit={!!limit || !slots.has("github:limit")}
              canAlways={!limit || !slots.has("github")}
              onChange={onChange}
            />
          ) : (
            <span className="px-2.5 text-[13px] text-muted-foreground">{ruleText(step)}</span>
          )}
          {editable && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon-sm" variant="ghost" aria-label={`${label} options`}>
                  <MoreHorizontalIcon aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem disabled={index === 0} onSelect={() => onMove(-1)}>
                  Move up
                </DropdownMenuItem>
                <DropdownMenuItem disabled={index === count - 1} onSelect={() => onMove(1)}>
                  Move down
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" disabled={count === 1} onSelect={onRemove}>
                  Remove
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        {limit && <UsageBars accounts={accounts} percent={limit.percent} />}
      </div>
    </li>
  );
}

function ruleText(step: RunnerStep) {
  if (step.key === "machine") return "When one is free";
  if (step.key === "github" && step.limit) return `While under ${step.limit.percent}%`;
  return "Always";
}

/** The GitHub step's rule: a compact menu of "while under N%" and "always". */
function GitHubRule({
  step,
  limits,
  accounts,
  canLimit,
  canAlways,
  onChange,
}: {
  step: Extract<RunnerStep, { key: "github" }>;
  limits: LimitAvailability;
  accounts: AccountUsage[];
  canLimit: boolean;
  canAlways: boolean;
  onChange: (step: RunnerStep) => void;
}) {
  const [percent, setPercent] = useState(String(step.limit?.percent ?? DEFAULT_LIMIT_PERCENT));
  const withQuota = accounts.filter(hasQuota);
  const only = withQuota.length === 1 ? withQuota[0] : undefined;
  const quota = only ? `of ${only.quotaMinutes!.toLocaleString("en-US")} min` : null;

  function setLimit(value = percent) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) return;
    onChange({ key: "github", limit: { percent: Math.min(100, Math.max(1, parsed)) } });
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5 px-2.5 text-[13px] font-normal">
          {ruleText(step)}
          <ChevronDownIcon aria-hidden className="size-3.5 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-1 text-[13px]">
        <div role="radiogroup" aria-label="When GitHub-hosted takes jobs" className="grid">
          {limits.allowed ? (
            <div className="flex items-center gap-1 rounded-md pr-2 hover:bg-accent/60">
              <button
                type="button"
                role="radio"
                aria-checked={!!step.limit}
                disabled={!canLimit}
                onClick={() => setLimit()}
                className="flex flex-1 items-center gap-2 px-2 py-1.5 text-left whitespace-nowrap disabled:text-muted-foreground"
              >
                <Check on={!!step.limit} />
                While under
              </button>
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={100}
                value={percent}
                disabled={!canLimit}
                aria-label="Limit, percent of included minutes"
                onChange={(event) => {
                  setPercent(event.target.value);
                  if (step.limit) setLimit(event.target.value);
                }}
                className="h-6 w-10 rounded border bg-background px-1 text-right tabular-nums [appearance:textfield] focus-visible:border-ring focus-visible:outline-none [&::-webkit-inner-spin-button]:appearance-none"
              />
              <span>%</span>
              {quota && <span className="ml-auto text-xs text-muted-foreground">{quota}</span>}
            </div>
          ) : (
            <div
              role="radio"
              aria-checked={false}
              aria-disabled
              className="grid gap-0.5 px-2 py-1.5"
            >
              <span className="flex items-center gap-2 text-[var(--rr-idle)]">
                <Check on={false} />
                While under a limit
              </span>
              <span className="pl-6 text-xs text-muted-foreground">
                {limits.blocked}{" "}
                <Link to="/settings/github" className="text-go hover:text-go-hover">
                  Set up
                </Link>
              </span>
            </div>
          )}
          <button
            type="button"
            role="radio"
            aria-checked={!step.limit}
            disabled={!canAlways}
            onClick={() => onChange({ key: "github" })}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent/60 disabled:text-muted-foreground"
          >
            <Check on={!step.limit} />
            Always
            <span className="ml-auto text-xs text-muted-foreground">past the limit too</span>
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Check({ on }: { on: boolean }) {
  return (
    <span className="flex size-4 items-center justify-center">
      {on && <CheckIcon aria-hidden className="size-3.5" />}
    </span>
  );
}

/** Each account's minutes this month against its quota, with a tick at the limit. */
function UsageBars({ accounts, percent }: { accounts: AccountUsage[]; percent: number }) {
  const withQuota = accounts.filter(hasQuota);
  const first = withQuota[0];
  if (!first) return null;
  const resets = nextCycle(first.cycleStart);
  return (
    <div className="grid gap-2.5 pr-4 pb-3 pl-11">
      {withQuota.map((account) => {
        const quota = account.quotaMinutes!;
        const used = Math.floor((account.usedMinutes / quota) * 100);
        return (
          <div key={account.installationId} className="grid max-w-sm gap-1.5">
            <div
              role="img"
              aria-label={`${used}% of included minutes used, limit ${percent}%`}
              className="relative h-1.5 rounded-full bg-border"
            >
              <div
                className={cn(
                  "absolute inset-y-0 left-0 rounded-full",
                  used >= percent ? "bg-[var(--rr-run)]" : "bg-[var(--rr-idle)]",
                )}
                style={{ width: `${Math.min(used, 100)}%` }}
              />
              <div
                className="absolute -inset-y-1 w-0.5 rounded-full bg-foreground"
                style={{ left: `calc(${percent}% - 1px)` }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {withQuota.length > 1 && `${account.accountLogin} · `}
              {Math.round(account.usedMinutes).toLocaleString("en-US")} of{" "}
              {quota.toLocaleString("en-US")} min · resets {resets}
            </p>
          </div>
        );
      })}
    </div>
  );
}

function nextCycle(cycleStart: string) {
  const start = new Date(cycleStart);
  const next = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  return next.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** The relay.yml inputs this order needs, as a snippet. */
function WorkflowPanel({ steps }: { steps: RunnerStep[] }) {
  const keys = (["machine", "github", "blacksmith"] as const).filter((key) =>
    steps.some((step) => step.key === key),
  );
  const snippet = [
    "jobs:",
    "  relay:",
    "    uses: relayrunner/actions/.github/workflows/relay.yml@v1.0.0-beta.4",
    "    with:",
    ...keys.map((key) => `      ${key}: ${EXAMPLE_INPUTS[key]}`),
    "  test:",
    "    needs: relay",
    "    runs-on: ${{ needs.relay.outputs.runner }}",
  ].join("\n");
  return (
    <section
      aria-label="In your workflow"
      className="grid min-w-0 flex-[1_1_300px] gap-2 rounded-lg border border-border/60 bg-[var(--rr-dormant)] px-4 py-3.5"
    >
      <h2 className="text-sm font-semibold">In your workflow</h2>
      <p className="text-[12.5px] text-muted-foreground">
        relay.yml takes one input per step. A job skips steps it doesn't name.
      </p>
      <pre className="overflow-x-auto rounded-md border border-border/60 bg-[var(--rr-bg-deep)] px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-[var(--rr-ink-2)]">
        {snippet}
      </pre>
    </section>
  );
}
