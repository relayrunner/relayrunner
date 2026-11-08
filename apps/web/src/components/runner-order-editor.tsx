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
  RUNNER_KEYS,
  RUNNER_LABELS,
  type RunnerKey,
  type RunnerStep,
} from "@relayrunner/runner-order";
import { ArrowDownIcon, ArrowUpIcon, GripVerticalIcon, PlusIcon, XIcon } from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { RunnerOrderError, saveRunnerOrder } from "@/lib/runner-order";
import { cn } from "@/lib/utils";

type SaveStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

/**
 * The runner order: providers in the order jobs try them. Moving a section moves that provider in
 * the order, and providers left out sit at the bottom. The page decides each provider's line and
 * what, if anything, shows inside its section.
 */
export function RunnerOrderEditor({
  workspaceId,
  order,
  isDefault,
  editable,
  meta,
  body,
}: {
  workspaceId: string;
  order: { steps: RunnerStep[] };
  isDefault: boolean;
  /** Owners and admins change the order (#134); members read it. The API refuses a member's save. */
  editable: boolean;
  meta: (key: RunnerKey) => string;
  body: (key: RunnerKey) => ReactNode;
}) {
  const router = useRouter();
  const [saved, setSaved] = useState({ steps: order.steps, isDefault });
  const [steps, setSteps] = useState<RunnerStep[]>(order.steps);
  const [status, setStatus] = useState<SaveStatus>({ kind: "idle" });
  const dirty = keys(steps) !== keys(saved.steps);
  const unused = RUNNER_KEYS.filter((key) => !steps.some((step) => step.key === key));

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
    const from = steps.findIndex((step) => step.key === active.id);
    const to = steps.findIndex((step) => step.key === over.id);
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

  return (
    <>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext
          items={steps.map((step) => step.key)}
          strategy={verticalListSortingStrategy}
        >
          <ol className="grid gap-3" aria-label="Runner order">
            {steps.map((step, index) => (
              <ProviderSection
                key={step.key}
                providerKey={step.key}
                meta={meta(step.key)}
                position={index + 1}
                editable={editable}
                canMoveUp={index > 0}
                canMoveDown={index < steps.length - 1}
                canRemove={steps.length > 1}
                onMove={(by) => change(arrayMove(steps, index, index + by))}
                onRemove={() => change(steps.filter((_, i) => i !== index))}
              >
                {body(step.key)}
              </ProviderSection>
            ))}
          </ol>
        </SortableContext>
      </DndContext>

      {unused.map((key) => (
        <UnusedSection
          key={key}
          providerKey={key}
          onAdd={editable ? () => change([...steps, { key }]) : undefined}
        >
          {body(key)}
        </UnusedSection>
      ))}

      <p className="text-sm text-muted-foreground">
        A job only uses the steps its workflow names. Public repos skip self-hosted runners. If no
        step can take a job, it stops early and says why.
      </p>

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
    </>
  );
}

const keys = (steps: RunnerStep[]) => steps.map((step) => step.key).join(",");

function ProviderSection({
  providerKey,
  meta,
  position,
  editable,
  canMoveUp,
  canMoveDown,
  canRemove,
  onMove,
  onRemove,
  children,
}: {
  providerKey: RunnerKey;
  meta: string;
  position: number;
  editable: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  canRemove: boolean;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
  children: ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: providerKey, disabled: !editable });
  const label = RUNNER_LABELS[providerKey];

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "overflow-hidden rounded-lg border bg-background",
        isDragging && "relative z-10 shadow-lg ring-1 ring-ring/40",
      )}
    >
      <div className="flex items-center gap-2 bg-secondary px-2.5 py-2 sm:gap-3">
        {editable && (
          <button
            ref={setActivatorNodeRef}
            type="button"
            aria-label={`Drag ${label}`}
            className="hidden size-7 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none active:cursor-grabbing sm:flex"
            {...attributes}
            {...listeners}
          >
            <GripVerticalIcon aria-hidden className="size-4" />
          </button>
        )}
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full border font-mono text-xs text-muted-foreground tabular-nums">
          {position}
        </span>
        <div className="grid min-w-0 flex-1 gap-0.5">
          <h2 className="text-sm font-semibold">{label}</h2>
          <p className="text-xs text-muted-foreground">{meta}</p>
        </div>
        {editable && (
          <div className="flex shrink-0 items-center">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Move ${label} up`}
              disabled={!canMoveUp}
              onClick={() => onMove(-1)}
            >
              <ArrowUpIcon aria-hidden />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Move ${label} down`}
              disabled={!canMoveDown}
              onClick={() => onMove(1)}
            >
              <ArrowDownIcon aria-hidden />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Remove ${label} from the order`}
              title={canRemove ? undefined : "The order needs at least one provider."}
              disabled={!canRemove}
              onClick={onRemove}
            >
              <XIcon aria-hidden />
            </Button>
          </div>
        )}
      </div>
      {children && <div className="grid gap-2 border-t p-2">{children}</div>}
    </li>
  );
}

/** A provider left out of the order: jobs never run there. Its runners still show. */
function UnusedSection({
  providerKey,
  onAdd,
  children,
}: {
  providerKey: RunnerKey;
  /** Missing for members, who can't change the order. */
  onAdd?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-dashed">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="grid gap-0.5">
          <h2 className="text-sm font-semibold text-muted-foreground">
            {RUNNER_LABELS[providerKey]}
          </h2>
          <p className="text-xs text-muted-foreground">Not in the order. Jobs never run here.</p>
        </div>
        {onAdd && (
          <Button size="sm" variant="outline" onClick={onAdd}>
            <PlusIcon aria-hidden />
            Add to order
          </Button>
        )}
      </div>
      {children && (
        <div className="grid gap-2 border-t border-dashed p-2 opacity-70">{children}</div>
      )}
    </div>
  );
}
