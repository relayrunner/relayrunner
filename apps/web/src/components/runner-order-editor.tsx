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
  BLACKSMITH_FREE_MINUTES,
  DEFAULT_LIMIT_PERCENT,
  DEFAULT_SPEND_LIMIT_USD,
  hasSpendLimit,
  RUNNER_LABELS,
  stepSlot,
  type RunnerKey,
  type RunnerStep,
} from "@relayrunner/runner-order";
import { HOSTED_PROVIDER_IDS, type HostedProviderId } from "@relayrunner/providers";
import { Link, useRouter } from "@tanstack/react-router";
import {
  CheckIcon,
  ChevronDownIcon,
  GripVerticalIcon,
  MoreHorizontalIcon,
  PlusIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { ProviderMark } from "@/components/providers";
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
import { counted, type BlacksmithMinutes } from "@/lib/blacksmith-minutes";
import { AppError } from "@relayrunner/errors";
import type { Machine } from "@/lib/machines";
import { providerInfo } from "@/lib/provider-catalog";
import { previewRoute, type StepVerdict } from "@/lib/route-preview";
import { ruleText, saveRunnerOrder } from "@/lib/runner-order";
import { cn } from "@/lib/utils";

type SaveStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

/**
 * The runner order as a chain: each step hands a job to the next when it can't take it. Each step
 * says whether the next job would stop there; beside it, `aside`.
 */
export function RunnerOrderEditor({
  workspaceId,
  order,
  isDefault,
  editable,
  machines,
  accounts,
  blacksmith = null,
  installedApps = null,
  aside = null,
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
  /** This month's free Blacksmith minutes, from its connection; null when they couldn't be read. */
  blacksmith?: BlacksmithMinutes | null;
  /** The providers whose GitHub App the org has installed, or null when we can't tell. */
  installedApps?: HostedProviderId[] | null;
  /** Beside the order: the page's setup card. */
  aside?: ReactNode;
}) {
  const router = useRouter();
  const [saved, setSaved] = useState({ steps: order.steps, isDefault });
  const [steps, setSteps] = useState<RunnerStep[]>(order.steps);
  const [status, setStatus] = useState<SaveStatus>({ kind: "idle" });
  const dirty = JSON.stringify(steps) !== JSON.stringify(saved.steps);
  const preview = previewRoute(steps, machines, accounts, blacksmith);
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
        error instanceof AppError && error.code === "RUNNER_ORDER_INVALID"
          ? error.message
          : "Couldn't save the order. Try again.";
      setStatus({ kind: "error", message });
    }
  }

  const slots = new Set(steps.map(stepSlot));
  // GitHub and Blacksmith fit twice: once with a minutes limit, once without.
  const githubSlotFree = !slots.has("github") || (limits.allowed && !slots.has("github:limit"));
  const blacksmithConnected = blacksmith?.reason !== "not_connected";
  const blacksmithSlotFree =
    !slots.has("blacksmith") || (blacksmithConnected && !slots.has("blacksmith:limit"));
  function addStep(key: RunnerKey) {
    const limited = { percent: DEFAULT_LIMIT_PERCENT };
    const step: RunnerStep =
      key === "github" && slots.has("github")
        ? { key: "github", limit: limited }
        : key === "blacksmith" && slots.has("blacksmith")
          ? { key: "blacksmith", limit: limited }
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
                    blacksmith={blacksmith}
                    slots={slots}
                    appMissing={appMissing(step.key, installedApps)}
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
                  runner="machine"
                  note={slots.has("machine") ? "Already in the order" : SELF_HOSTED_NOTE}
                  disabled={slots.has("machine")}
                  onSelect={() => addStep("machine")}
                />
                <AddItem
                  runner="github"
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
                <DropdownMenuSeparator />
                {/* Only providers operators made Live (Admin › Providers); a Hidden one already
                    in the order keeps its step. */}
                {HOSTED_PROVIDER_IDS.filter(
                  (id) =>
                    providerInfo(id).status === "live" || slots.has(id) || slots.has(`${id}:limit`),
                ).map((id) => {
                  const taken = id === "blacksmith" ? !blacksmithSlotFree : slots.has(id);
                  return (
                    <AddItem
                      key={id}
                      runner={id}
                      note={
                        taken
                          ? "Already in the order"
                          : id === "blacksmith" && slots.has("blacksmith")
                            ? "Again, while under its free minutes"
                            : id === "blacksmith" && slots.has("blacksmith:limit")
                              ? "Again, past its free minutes"
                              : installedApps?.includes(id)
                                ? "App installed"
                                : `Needs ${RUNNER_LABELS[id]}'s GitHub app`
                      }
                      disabled={taken}
                      onSelect={() => addStep(id)}
                    />
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {aside}
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

/** What the Self-hosted step covers: runners added from GitHub and machines connected with the CLI. */
const SELF_HOSTED_NOTE = "Your own runners and CLI-connected machines";

function AddItem({
  runner,
  note,
  disabled,
  onSelect,
}: {
  runner: RunnerKey;
  note: string;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem
      disabled={disabled}
      onSelect={onSelect}
      className="grid grid-cols-[auto_1fr] items-start gap-x-2.5 gap-y-0.5"
    >
      <ProviderMark provider={runner} className="row-span-2 mt-0.5" />
      <span>{RUNNER_LABELS[runner]}</span>
      <span className="text-xs text-muted-foreground">{note}</span>
    </DropdownMenuItem>
  );
}

/**
 * Whether a GitHub step can use a minutes limit: only when some connected account has a quota
 * we know. When none does, `blocked` is the one line saying why, and `fixable` whether the
 * GitHub settings page has a way to fix it.
 */
type LimitAvailability = { allowed: true } | { allowed: false; blocked: string; fixable: boolean };

function limitAvailability(accounts: AccountUsage[]): LimitAvailability {
  if (accounts.some(hasQuota)) return { allowed: true };
  const blocked = (text: string, fixable = true) => ({
    allowed: false as const,
    blocked: text,
    fixable,
  });
  if (accounts.length === 0) return blocked("Connect a GitHub account first.");
  const reasons = new Set(accounts.map((account) => account.reason));
  if (reasons.has("missing_permission"))
    return blocked("Install RelayRunner Spend to share your org's billing.");
  if (reasons.has("sign_in_needed"))
    return blocked("Sign in again to share your account's minutes.");
  if (reasons.has("enterprise")) return blocked("Needs RelayRunner on your enterprise.");
  if (reasons.has("enterprise_permission"))
    return blocked("Your enterprise needs to accept RelayRunner's billing permission.");
  if (reasons.has("not_read_yet")) return blocked("Waiting for the first minutes reading.", false);
  return blocked("Your GitHub plan's minutes aren't known.");
}

function StepCard({
  step,
  index,
  count,
  verdict,
  editable,
  accounts,
  limits,
  blacksmith,
  slots,
  appMissing,
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
  blacksmith: BlacksmithMinutes | null;
  slots: Set<string>;
  /** A hosted provider whose GitHub App the org doesn't have, so its runners never start. */
  appMissing: boolean;
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
  const limit = "limit" in step ? step.limit : undefined;
  const withQuota = accounts.filter(hasQuota);

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
          <ProviderMark provider={step.key} />
          {/* At least 8rem and never narrower than the name, so on a phone the rule wraps under
              it instead of the name breaking across lines. */}
          <div className="grid flex-[1_1_8rem] gap-0.5">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold whitespace-nowrap">{label}</h2>
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
            {step.key === "machine" && (
              <p className="text-xs text-muted-foreground">{SELF_HOSTED_NOTE}</p>
            )}
            {step.key !== "machine" && step.key !== "github" && (
              <p className="text-xs text-muted-foreground">Sized per job under Workflows</p>
            )}
            {step.key === "blacksmith" && !limit && blacksmith?.reason === "not_connected" && (
              <p className="text-xs text-muted-foreground">
                Stop at its {BLACKSMITH_FREE_MINUTES.toLocaleString("en-US")} free minutes:{" "}
                <Link to="/settings/providers" className="text-go hover:text-go-hover">
                  connect Blacksmith
                </Link>
              </p>
            )}
            {appMissing && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0 text-destructive" />
                GitHub app not installed, so jobs here won't start.
              </p>
            )}
          </div>
          <div className="ml-auto flex items-center gap-2.5">
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
            ) : step.key === "blacksmith" && editable ? (
              <BlacksmithRule
                step={step}
                blacksmith={blacksmith}
                canLimit={!!limit || !slots.has("blacksmith:limit")}
                canOther={!limit || !slots.has("blacksmith")}
                onChange={onChange}
              />
            ) : step.key !== "machine" &&
              step.key !== "github" &&
              hasSpendLimit(step.key) &&
              editable ? (
              <SpendRule step={step} onChange={onChange} />
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
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={count === 1}
                    onSelect={onRemove}
                  >
                    Remove
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
        {limit && step.key === "github" && (
          <UsageBars
            bars={withQuota.map((account) => accountBar(account, withQuota.length > 1))}
            percent={limit.percent}
          />
        )}
        {limit && step.key === "blacksmith" && (
          <BlacksmithUsage blacksmith={blacksmith} percent={limit.percent} />
        )}
      </div>
    </li>
  );
}

/** Whether a step is a hosted provider the org hasn't installed. False when we can't tell. */
function appMissing(key: RunnerKey, installed: HostedProviderId[] | null) {
  if (!installed || key === "machine" || key === "github") return false;
  return !installed.includes(key);
}

type HostedStep = Exclude<RunnerStep, { key: "machine" | "github" }>;

const NUMBER_INPUT =
  "h-6 rounded border bg-background px-1 text-right tabular-nums [appearance:textfield] focus-visible:border-ring focus-visible:outline-none disabled:opacity-60 [&::-webkit-inner-spin-button]:appearance-none";

/** A rule's trigger: the rule as it reads now, opening its menu. */
function RuleMenu({
  step,
  label,
  children,
}: {
  step: RunnerStep;
  label: string;
  children: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5 px-2.5 text-[13px] font-normal">
          {ruleText(step)}
          <ChevronDownIcon aria-hidden className="size-3.5 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-1 text-[13px]">
        <div role="radiogroup" aria-label={`When ${label} takes jobs`} className="grid">
          {children}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** "While under [80] %" or "While under $[100] a month": a choice with a number to set. */
function LimitChoice({
  on,
  disabled = false,
  value,
  min,
  max,
  prefix,
  suffix,
  note,
  inputLabel,
  onPick,
}: {
  on: boolean;
  disabled?: boolean;
  value: number;
  min: number;
  max: number;
  prefix?: string;
  suffix: string;
  note?: string | null;
  inputLabel: string;
  /** Picks this choice at `value`, kept within min and max. */
  onPick: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  const pick = (raw = text) => {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isNaN(parsed)) onPick(Math.min(max, Math.max(min, parsed)));
  };
  return (
    <div className="flex items-center gap-1 rounded-md pr-2 hover:bg-accent/60">
      <button
        type="button"
        role="radio"
        aria-checked={on}
        disabled={disabled}
        onClick={() => pick()}
        className="flex flex-1 items-center gap-2 px-2 py-1.5 text-left whitespace-nowrap disabled:text-muted-foreground"
      >
        <Check on={on} />
        While under
      </button>
      {prefix && <span>{prefix}</span>}
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={text}
        disabled={disabled}
        aria-label={inputLabel}
        onChange={(event) => {
          setText(event.target.value);
          if (on) pick(event.target.value);
        }}
        className={cn(NUMBER_INPUT, max > 100 ? "w-16" : "w-10")}
      />
      <span>{suffix}</span>
      {note && <span className="ml-auto pl-1 text-xs text-muted-foreground">{note}</span>}
    </div>
  );
}

/** A limit this step can't use yet, with what's missing and where to set it up. */
function BlockedChoice({
  title,
  blocked,
  setUp,
}: {
  title: string;
  blocked: string;
  /** The settings page that fixes it, if one does. */
  setUp: "/settings/github" | "/settings/providers" | null;
}) {
  return (
    <div role="radio" aria-checked={false} aria-disabled className="grid gap-0.5 px-2 py-1.5">
      <span className="flex items-center gap-2 text-[var(--rr-idle)]">
        <Check on={false} />
        {title}
      </span>
      <span className="pl-6 text-xs text-muted-foreground">
        {blocked}
        {setUp && (
          <>
            {" "}
            <Link to={setUp} className="text-go hover:text-go-hover">
              Set up
            </Link>
          </>
        )}
      </span>
    </div>
  );
}

function AlwaysChoice({
  on,
  disabled = false,
  note,
  onPick,
}: {
  on: boolean;
  disabled?: boolean;
  note?: string;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      disabled={disabled}
      onClick={onPick}
      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent/60 disabled:text-muted-foreground"
    >
      <Check on={on} />
      Always
      {note && <span className="ml-auto text-xs text-muted-foreground">{note}</span>}
    </button>
  );
}

const spendChoice = (step: HostedStep, onChange: (step: RunnerStep) => void, disabled = false) => (
  <LimitChoice
    on={!!step.spendLimit}
    disabled={disabled}
    value={step.spendLimit?.usd ?? DEFAULT_SPEND_LIMIT_USD}
    min={1}
    max={100_000}
    prefix="$"
    suffix="a month"
    inputLabel="Limit, dollars a month"
    onPick={(usd) => onChange({ key: step.key, spendLimit: { usd } })}
  />
);

/** A priced hosted provider's rule: "while under $N a month" or "always". */
function SpendRule({ step, onChange }: { step: HostedStep; onChange: (step: RunnerStep) => void }) {
  return (
    <RuleMenu step={step} label={RUNNER_LABELS[step.key]}>
      {spendChoice(step, onChange)}
      <AlwaysChoice on={!step.spendLimit} onPick={() => onChange({ key: step.key })} />
    </RuleMenu>
  );
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
  const withQuota = accounts.filter(hasQuota);
  const only = withQuota.length === 1 ? withQuota[0] : undefined;
  return (
    <RuleMenu step={step} label="GitHub-hosted">
      {limits.allowed ? (
        <LimitChoice
          on={!!step.limit}
          disabled={!canLimit}
          value={step.limit?.percent ?? DEFAULT_LIMIT_PERCENT}
          min={1}
          max={100}
          suffix="%"
          note={only && `of ${only.quotaMinutes!.toLocaleString("en-US")} min`}
          inputLabel="Limit, percent of included minutes"
          onPick={(percent) => onChange({ key: "github", limit: { percent } })}
        />
      ) : (
        <BlockedChoice
          title="While under a limit"
          blocked={limits.blocked}
          setUp={limits.fixable ? "/settings/github" : null}
        />
      )}
      <AlwaysChoice
        on={!step.limit}
        disabled={!canAlways}
        note="past the limit too"
        onPick={() => onChange({ key: "github" })}
      />
    </RuleMenu>
  );
}

/**
 * The Blacksmith step's rule: "while under N% of its free minutes", which needs Blacksmith
 * connected in Settings › Providers to count them, "while under $N a month", or "always".
 */
function BlacksmithRule({
  step,
  blacksmith,
  canLimit,
  canOther,
  onChange,
}: {
  step: Extract<RunnerStep, { key: "blacksmith" }>;
  blacksmith: BlacksmithMinutes | null;
  /** Each rule fits once: a second Blacksmith step can't take the first's. */
  canLimit: boolean;
  canOther: boolean;
  onChange: (step: RunnerStep) => void;
}) {
  const connected = blacksmith && blacksmith.reason !== "not_connected";
  const free = (blacksmith?.quotaMinutes ?? BLACKSMITH_FREE_MINUTES).toLocaleString("en-US");
  return (
    <RuleMenu step={step} label="Blacksmith">
      {connected || step.limit ? (
        <LimitChoice
          on={!!step.limit}
          disabled={!canLimit}
          value={step.limit?.percent ?? DEFAULT_LIMIT_PERCENT}
          min={1}
          max={100}
          suffix="%"
          note={`of ${free} free min`}
          inputLabel="Limit, percent of Blacksmith's free minutes"
          onPick={(percent) => onChange({ key: "blacksmith", limit: { percent } })}
        />
      ) : (
        <BlockedChoice
          title={`While under its ${free} free minutes`}
          blocked={
            blacksmith
              ? "Connect Blacksmith to count its free minutes."
              : "Blacksmith's free minutes couldn't be read."
          }
          setUp={blacksmith ? "/settings/providers" : null}
        />
      )}
      {hasSpendLimit("blacksmith") && spendChoice(step, onChange, !canOther)}
      <AlwaysChoice
        on={!step.limit && !step.spendLimit}
        disabled={!canOther}
        onPick={() => onChange({ key: "blacksmith" })}
      />
    </RuleMenu>
  );
}

function Check({ on }: { on: boolean }) {
  return (
    <span className="flex size-4 items-center justify-center">
      {on && <CheckIcon aria-hidden className="size-3.5" />}
    </span>
  );
}

/** One bar of minutes used against a quota: an account's, or Blacksmith's free minutes. */
type UsageBar = {
  id: string;
  /** Who the minutes are, when there's more than one bar. */
  who: string | null;
  usedMinutes: number;
  quotaMinutes: number;
  cycleStart: string;
  /** What the minutes are, for screen readers, and how the caption counts them. */
  kind: string;
  unit: string;
};

const accountBar = (account: AccountUsage, many: boolean): UsageBar => ({
  id: String(account.installationId),
  who: many ? account.accountLogin : null,
  usedMinutes: account.usedMinutes,
  quotaMinutes: account.quotaMinutes!,
  cycleStart: account.cycleStart,
  kind: "included minutes",
  unit: "min",
});

/** Each bar's minutes this month against its quota, with a tick at the limit. */
function UsageBars({ bars, percent }: { bars: UsageBar[]; percent: number }) {
  if (bars.length === 0) return null;
  return (
    <div className="grid gap-2.5 pr-4 pb-3 pl-11">
      {bars.map((bar) => {
        const used = Math.floor((bar.usedMinutes / bar.quotaMinutes) * 100);
        return (
          <div key={bar.id} className="grid max-w-sm gap-1.5">
            <div
              role="img"
              aria-label={`${used}% of ${bar.kind} used, limit ${percent}%`}
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
              {bar.who && `${bar.who} · `}
              {Math.round(bar.usedMinutes).toLocaleString("en-US")} of{" "}
              {bar.quotaMinutes.toLocaleString("en-US")} {bar.unit} · resets{" "}
              {nextCycle(bar.cycleStart)}
            </p>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The limited Blacksmith step's free minutes: a bar once they're counted, else what's missing,
 * since until then the step takes every job.
 */
function BlacksmithUsage({
  blacksmith,
  percent,
}: {
  blacksmith: BlacksmithMinutes | null;
  percent: number;
}) {
  const warning = blacksmithWarning(blacksmith);
  return (
    <>
      {counted(blacksmith) && (
        <UsageBars
          bars={[
            {
              id: "blacksmith",
              who: null,
              usedMinutes: blacksmith.usedMinutes,
              quotaMinutes: blacksmith.quotaMinutes,
              cycleStart: blacksmith.cycleStart,
              kind: "free minutes",
              unit: "free min",
            },
          ]}
          percent={percent}
        />
      )}
      {warning && (
        <p className="flex items-start gap-1.5 pr-4 pb-3 pl-11 text-xs text-muted-foreground">
          <TriangleAlertIcon aria-hidden className="mt-px size-3.5 shrink-0 text-destructive" />
          <span>
            {warning.text}
            {warning.setUp && (
              <>
                {" "}
                <Link to="/settings/providers" className="text-go hover:text-go-hover">
                  {warning.setUp}
                </Link>
              </>
            )}
          </span>
        </p>
      )}
    </>
  );
}

/** Why a limited Blacksmith step can't count its free minutes right now, if it can't. */
function blacksmithWarning(
  blacksmith: BlacksmithMinutes | null,
): { text: string; setUp: string | null } | null {
  const takesAll = "so Blacksmith takes every job until then.";
  if (!blacksmith) return { text: `Blacksmith's free minutes couldn't be read.`, setUp: null };
  switch (blacksmith.reason) {
    case null:
      return null;
    case "not_connected":
      return {
        text: "Blacksmith isn't connected, so its free minutes aren't counted and Blacksmith takes every job.",
        setUp: "Connect Blacksmith",
      };
    case "not_synced":
      return { text: `The first Blacksmith sync runs within the hour, ${takesAll}`, setUp: null };
    case "token_rejected":
      return {
        text: "Blacksmith stopped accepting the token, so its free minutes aren't counted and Blacksmith takes every job.",
        setUp: "Paste a new one",
      };
    case "sync_failed":
      return {
        text: "The last Blacksmith sync failed, so these minutes may be behind.",
        setUp: "See the connection",
      };
  }
}

function nextCycle(cycleStart: string) {
  const start = new Date(cycleStart);
  const next = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  return next.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
