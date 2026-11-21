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
  DEFAULT_SPEND_LIMIT_USD,
  FREE_MINUTES,
  type FreeMinutesProvider,
  hasMinutesLimit,
  hasSpendLimit,
  isFreeMinutesProvider,
  RUNNER_LABELS,
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
import {
  barMarks,
  capText,
  type Handoff,
  handoffText,
  minutes,
  unreachableText,
} from "@/lib/spend-caps";
import { counted, type FreeMinutes, type FreeMinutesByProvider } from "@/lib/free-minutes";
import { AppError } from "@relayrunner/errors";
import type { Machine } from "@/lib/machines";
import { providerInfo } from "@/lib/provider-catalog";
import { previewRoute, type StepVerdict } from "@/lib/route-preview";
import { saveRunnerOrder } from "@/lib/runner-order";
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
  freeMinutes = {},
  installedApps = null,
  spend = null,
  boatConnected = false,
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
  /**
   * This month's free minutes on Blacksmith and Groundbox, from their connections; a provider's is
   * null when it couldn't be read.
   */
  freeMinutes?: FreeMinutesByProvider;
  /** The providers whose GitHub App the org has installed, or null when we can't tell. */
  installedApps?: HostedProviderId[] | null;
  /**
   * What the workspace spent on each usage-billed provider this UTC month, in dollars at list
   * prices, or null when it couldn't be read (those steps then show no spend).
   */
  spend?: Partial<Record<HostedProviderId, number>> | null;
  /** Whether the workspace connected Boat, so its step passes jobs on at its start limits. */
  boatConnected?: boolean;
  /** Beside the order: the page's setup card. */
  aside?: ReactNode;
}) {
  const router = useRouter();
  const [saved, setSaved] = useState({ steps: order.steps, isDefault });
  // Each step gets its own id: a provider can appear any number of times, so its key can't be one.
  const [items, setItems] = useState(() => withIds(order.steps));
  const steps = items.map((item) => item.step);
  const [status, setStatus] = useState<SaveStatus>({ kind: "idle" });
  const dirty = JSON.stringify(steps) !== JSON.stringify(saved.steps);
  const preview = previewRoute(steps, machines, accounts, freeMinutes);
  const limits = limitAvailability(accounts);

  function change(next: StepItem[]) {
    setItems(next);
    setStatus({ kind: "idle" });
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  function onDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    const from = items.findIndex((item) => item.id === active.id);
    const to = items.findIndex((item) => item.id === over.id);
    change(arrayMove(items, from, to));
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

  const hasMachine = steps.some((step) => step.key === "machine");
  function addStep(key: RunnerKey) {
    // A provider already in the order comes back capped, ready to be the next tier.
    const again = steps.some((step) => step.key === key);
    const step: RunnerStep =
      again && hasMinutesLimit(key) ? { key, limit: { percent: DEFAULT_LIMIT_PERCENT } } : { key };
    change([...items, ...withIds([step])]);
  }

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-start gap-6">
        <div className="grid min-w-0 flex-[1_1_480px] gap-1.5">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext
              items={items.map((item) => item.id)}
              strategy={verticalListSortingStrategy}
            >
              <ol className="grid" aria-label="Runner order">
                {items.map(({ id, step }, index) => (
                  <StepCard
                    key={id}
                    id={id}
                    step={step}
                    unreachable={unreachableText(steps, index)}
                    handoff={
                      index > 0
                        ? handoffText(steps[index - 1]!, accounts, freeMinutes, boatConnected)
                        : null
                    }
                    index={index}
                    count={steps.length}
                    verdict={preview.steps[index]}
                    editable={editable}
                    accounts={accounts}
                    limits={limits}
                    freeMinutes={freeMinutes}
                    spend={spend}
                    appMissing={appMissing(step.key, installedApps)}
                    onChange={(next) =>
                      change(
                        items.map((item, i) => (i === index ? { id: item.id, step: next } : item)),
                      )
                    }
                    onMove={(by) => change(arrayMove(items, index, index + by))}
                    onRemove={() => change(items.filter((_, i) => i !== index))}
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
                  note={hasMachine ? "Already in the order" : SELF_HOSTED_NOTE}
                  disabled={hasMachine}
                  onSelect={() => addStep("machine")}
                />
                <AddItem
                  runner="github"
                  note="GitHub's own runners"
                  disabled={false}
                  onSelect={() => addStep("github")}
                />
                <DropdownMenuSeparator />
                {/* Only providers operators made Live (Admin › Providers); a Hidden one already
                    in the order keeps its step. */}
                {HOSTED_PROVIDER_IDS.filter(
                  (id) =>
                    providerInfo(id).status === "live" || steps.some((step) => step.key === id),
                ).map((id) => (
                  <AddItem
                    key={id}
                    runner={id}
                    note={
                      installedApps?.includes(id)
                        ? "App installed"
                        : `Needs ${RUNNER_LABELS[id]}'s GitHub app`
                    }
                    disabled={false}
                    onSelect={() => addStep(id)}
                  />
                ))}
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
              <Button size="sm" variant="ghost" onClick={() => change(withIds(saved.steps))}>
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

type StepItem = { id: string; step: RunnerStep };

let nextStepId = 0;
const withIds = (steps: RunnerStep[]): StepItem[] =>
  steps.map((step) => ({ id: `step-${nextStepId++}`, step }));

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
  id,
  step,
  handoff,
  unreachable,
  index,
  count,
  verdict,
  editable,
  accounts,
  limits,
  freeMinutes,
  spend,
  appMissing,
  onChange,
  onMove,
  onRemove,
}: {
  id: string;
  step: RunnerStep;
  /** Above the card: what sends a job here from the step before, or null for the first step. */
  handoff: Handoff | null;
  /** Why no job can reach this step, or null. */
  unreachable: string | null;
  index: number;
  count: number;
  verdict: StepVerdict | undefined;
  editable: boolean;
  accounts: AccountUsage[];
  limits: LimitAvailability;
  freeMinutes: FreeMinutesByProvider;
  spend: Partial<Record<HostedProviderId, number>> | null;
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
  } = useSortable({ id, disabled: !editable });
  const label = RUNNER_LABELS[step.key];
  const limit = "limit" in step ? step.limit : undefined;
  const withQuota = accounts.filter(hasQuota);
  // The free minutes this step's provider counts, if it's one that does.
  const free = isFreeMinutesProvider(step.key) ? (freeMinutes[step.key] ?? null) : null;

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("grid", isDragging && "relative z-10")}
    >
      {handoff && (
        <div className="flex min-h-7 items-stretch gap-2.5 pl-[19px]">
          <span aria-hidden className="w-px shrink-0 bg-border" />
          <span
            className={cn(
              "flex items-center gap-1.5 py-1 text-xs",
              handoff.warn ? "text-[var(--rr-run)]" : "text-muted-foreground",
            )}
          >
            {handoff.warn && (
              <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0 text-[var(--rr-run)]" />
            )}
            <span>
              {handoff.text}
              {handoff.connect && (
                <>
                  {". "}
                  <Link to="/settings/providers" className="text-go hover:text-go-hover">
                    {handoff.connect}
                  </Link>
                </>
              )}
            </span>
          </span>
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
            {isFreeMinutesProvider(step.key) && !limit && free?.reason === "not_connected" && (
              <p className="text-xs text-muted-foreground">
                Stop at its {FREE_MINUTES[step.key].toLocaleString("en-US")} free minutes:{" "}
                <Link to="/settings/providers" className="text-go hover:text-go-hover">
                  connect {label}
                </Link>
              </p>
            )}
            {unreachable && <p className="text-xs text-muted-foreground">{unreachable}</p>}
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
                canLimit
                canAlways
                onChange={onChange}
              />
            ) : (step.key === "blacksmith" || step.key === "groundbox") && editable ? (
              <FreeMinutesRule step={step} free={free} canLimit canOther onChange={onChange} />
            ) : step.key !== "machine" &&
              step.key !== "github" &&
              hasSpendLimit(step.key) &&
              editable ? (
              <SpendRule step={step} onChange={onChange} />
            ) : (
              <span className="px-2.5 text-[13px] text-muted-foreground">
                {capText(step, accounts, freeMinutes)}
              </span>
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
        {limit && isFreeMinutesProvider(step.key) && (
          <FreeMinutesUsage provider={step.key} free={free} percent={limit.percent} />
        )}
        {!limit && step.key === "github" && accounts.length > 0 && (
          <SpendBar
            // What GitHub billed this month past included minutes, across connected accounts.
            spentUsd={accounts.reduce((sum, account) => sum + account.netAmount, 0)}
            capUsd={step.spendLimit?.usd ?? null}
            spent="billed by GitHub"
          />
        )}
        {!limit && step.key !== "machine" && step.key !== "github" && hasSpendLimit(step.key) && (
          <SpendBar
            spentUsd={spend ? (spend[step.key] ?? 0) : null}
            capUsd={"spendLimit" in step ? (step.spendLimit?.usd ?? null) : null}
          />
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
  trigger,
  label,
  children,
}: {
  trigger: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5 px-2.5 text-[13px] font-normal">
          {trigger}
          <ChevronDownIcon aria-hidden className="size-3.5 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-1 text-[13px]">
        <div className="grid gap-0.5 px-2 pt-1.5 pb-2">
          <p className="text-sm font-semibold">Spend cap</p>
          <p className="text-xs text-muted-foreground">
            Once {label} reaches its cap, jobs go to the next step until the month resets.
          </p>
        </div>
        <div role="radiogroup" aria-label={`${label} spend cap`} className="grid">
          {children}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** "Included minutes [80] %" or "Monthly spend $[100] a month": a cap with a number to set. */
function LimitChoice({
  on,
  title,
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
  title: string;
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
        {title}
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
      No cap
      {note && <span className="ml-auto text-xs text-muted-foreground">{note}</span>}
    </button>
  );
}

const spendChoice = (step: HostedStep, onChange: (step: RunnerStep) => void, disabled = false) => (
  <LimitChoice
    on={!!step.spendLimit}
    title="Monthly spend"
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

/** A priced hosted provider's spend cap: a monthly dollar cap, or none. */
function SpendRule({ step, onChange }: { step: HostedStep; onChange: (step: RunnerStep) => void }) {
  return (
    <RuleMenu trigger={capText(step, [])} label={RUNNER_LABELS[step.key]}>
      {spendChoice(step, onChange)}
      <AlwaysChoice on={!step.spendLimit} onPick={() => onChange({ key: step.key })} />
    </RuleMenu>
  );
}

/** The GitHub step's spend cap: a share of included minutes, a monthly dollar cap, or none. */
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
    <RuleMenu trigger={capText(step, accounts)} label="GitHub">
      {limits.allowed ? (
        <LimitChoice
          on={!!step.limit}
          title="Included minutes"
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
          title="Included minutes"
          blocked={limits.blocked}
          setUp={limits.fixable ? "/settings/github" : null}
        />
      )}
      <LimitChoice
        on={!!step.spendLimit}
        title="Monthly spend"
        disabled={!canAlways}
        value={step.spendLimit?.usd ?? DEFAULT_SPEND_LIMIT_USD}
        min={1}
        max={100_000}
        prefix="$"
        suffix="a month"
        inputLabel="Limit, dollars a month past included minutes"
        onPick={(usd) => onChange({ key: "github", spendLimit: { usd } })}
      />
      <AlwaysChoice
        on={!step.limit && !step.spendLimit}
        disabled={!canAlways}
        note="billed past included minutes"
        onPick={() => onChange({ key: "github" })}
      />
    </RuleMenu>
  );
}

/**
 * A Blacksmith or Groundbox step's spend cap: a share of its free minutes, which needs the provider
 * connected in Settings › Providers to count them, a monthly dollar cap, or none.
 */
function FreeMinutesRule({
  step,
  free,
  canLimit,
  canOther,
  onChange,
}: {
  step: Extract<RunnerStep, { key: FreeMinutesProvider }>;
  free: FreeMinutes | null;
  /** Each rule fits once: a second step for the provider can't take the first's. */
  canLimit: boolean;
  canOther: boolean;
  onChange: (step: RunnerStep) => void;
}) {
  const { key } = step;
  const label = RUNNER_LABELS[key];
  const connected = free && free.reason !== "not_connected";
  const quota = (free?.quotaMinutes ?? FREE_MINUTES[key]).toLocaleString("en-US");
  return (
    <RuleMenu trigger={capText(step, [], { [key]: free })} label={label}>
      {connected || step.limit ? (
        <LimitChoice
          on={!!step.limit}
          title="Free minutes"
          disabled={!canLimit}
          value={step.limit?.percent ?? DEFAULT_LIMIT_PERCENT}
          min={1}
          max={100}
          suffix="%"
          note={`of ${quota} free min`}
          inputLabel={`Limit, percent of ${label}'s free minutes`}
          onPick={(percent) => onChange({ key, limit: { percent } })}
        />
      ) : (
        <BlockedChoice
          title={`Free minutes (${quota})`}
          blocked={
            free
              ? `Connect ${label} to count its free minutes.`
              : `${label}'s free minutes couldn't be read.`
          }
          setUp={free ? "/settings/providers" : null}
        />
      )}
      {hasSpendLimit(key) && spendChoice(step, onChange, !canOther)}
      <AlwaysChoice
        on={!step.limit && !step.spendLimit}
        disabled={!canOther}
        onPick={() => onChange({ key })}
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

/** One bar of minutes used against a quota: an account's, or a provider's free minutes. */
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
        const marks = barMarks(
          bar.usedMinutes,
          (bar.quotaMinutes * percent) / 100,
          bar.quotaMinutes,
        );
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
                style={{ width: `${marks.fill}%` }}
              />
              <div
                className="absolute -inset-y-1 w-0.5 rounded-full bg-foreground"
                style={{ left: `calc(${marks.tick}% - 1px)` }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {bar.who && `${bar.who} · `}
              {Math.round(bar.usedMinutes).toLocaleString("en-US")} of{" "}
              {bar.quotaMinutes.toLocaleString("en-US")} {bar.unit} · cap{" "}
              {minutes((bar.quotaMinutes * percent) / 100)} · resets {nextCycle(bar.cycleStart)}
            </p>
          </div>
        );
      })}
    </div>
  );
}

/** Where a dollar cap's tick sits along its bar. */
const CAP_TICK_PERCENT = 80;

const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

/**
 * A usage-billed provider's spend this month. With a cap, a bar shows how close the step is to
 * handing jobs on; without one, a line says what it has cost so far.
 */
function SpendBar({
  spentUsd,
  capUsd,
  spent = "spent",
}: {
  spentUsd: number | null;
  capUsd: number | null;
  /** How the spend was counted: "spent" at list prices, or "billed by GitHub". */
  spent?: string;
}) {
  if (spentUsd === null) return null;
  const resets = nextCycle(new Date().toISOString());
  if (capUsd === null)
    return (
      <p className="pr-4 pb-3 pl-11 text-xs text-muted-foreground">
        {usd(spentUsd)} {spent} this month · no cap · resets {resets}
      </p>
    );
  const used = Math.floor((spentUsd / capUsd) * 100);
  // A dollar cap has no quota behind it, so the bar runs a little past the cap and the tick sits
  // at the same kind of spot as a minutes cap. Spend past the end of that fills the bar, and the
  // tick moves left to where the cap falls in it: at twice the cap it sits halfway.
  const { fill, tick } = barMarks(
    spentUsd,
    capUsd,
    Math.max(capUsd / (CAP_TICK_PERCENT / 100), spentUsd),
  );
  return (
    <div className="grid gap-2.5 pr-4 pb-3 pl-11">
      <div className="grid max-w-sm gap-1.5">
        <div
          role="img"
          aria-label={`${used}% of the ${usd(capUsd)} cap spent`}
          className="relative h-1.5 rounded-full bg-border"
        >
          <div
            className={cn(
              "absolute inset-y-0 left-0 rounded-full",
              used >= 100 ? "bg-[var(--rr-run)]" : "bg-[var(--rr-idle)]",
            )}
            style={{ width: `${fill}%` }}
          />
          <div
            className="absolute -inset-y-1 w-0.5 rounded-full bg-foreground"
            style={{ left: `calc(${tick}% - 1px)` }}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {usd(spentUsd)} of {usd(capUsd)} {spent} ·{" "}
          {spentUsd > capUsd ? `${usd(spentUsd - capUsd)} over` : `${usd(capUsd - spentUsd)} left`}{" "}
          · resets {resets}
        </p>
      </div>
    </div>
  );
}

/**
 * A limited Blacksmith or Groundbox step's free minutes: a bar once they're counted, else what's
 * missing, since until then the step takes every job.
 */
function FreeMinutesUsage({
  provider,
  free,
  percent,
}: {
  provider: FreeMinutesProvider;
  free: FreeMinutes | null;
  percent: number;
}) {
  const warning = freeMinutesWarning(provider, free);
  return (
    <>
      {counted(free) && (
        <UsageBars
          bars={[
            {
              id: provider,
              who: null,
              usedMinutes: free.usedMinutes,
              quotaMinutes: free.quotaMinutes,
              cycleStart: free.cycleStart,
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

/** Why a limited step can't count its provider's free minutes right now, if it can't. */
function freeMinutesWarning(
  provider: FreeMinutesProvider,
  free: FreeMinutes | null,
): { text: string; setUp: string | null } | null {
  const label = RUNNER_LABELS[provider];
  const takesAll = `so ${label} takes every job until then.`;
  if (!free) return { text: `${label}'s free minutes couldn't be read.`, setUp: null };
  switch (free.reason) {
    case null:
      return null;
    case "not_connected":
      return {
        text: `${label} isn't connected, so its free minutes aren't counted and ${label} takes every job.`,
        setUp: `Connect ${label}`,
      };
    case "not_synced":
      return { text: `The first ${label} sync runs within the hour, ${takesAll}`, setUp: null };
    case "token_rejected":
      return {
        text: `${label} stopped accepting the token, so its free minutes aren't counted and ${label} takes every job.`,
        setUp: "Paste a new one",
      };
    case "sync_failed":
      return {
        text: `The last ${label} sync failed, so these minutes may be behind.`,
        setUp: "See the connection",
      };
    case "read_failed":
      return {
        text: `${label}'s account couldn't be read just now, so ${label} takes jobs until it can be.`,
        setUp: null,
      };
    case "no_free_minutes":
      return {
        text: `${label}'s plan has no free minutes to stop at, so ${label} takes every job.`,
        setUp: null,
      };
  }
}

function nextCycle(cycleStart: string) {
  const start = new Date(cycleStart);
  const next = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  return next.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
