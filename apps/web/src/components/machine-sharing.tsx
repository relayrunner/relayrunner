import { useRouter } from "@tanstack/react-router";
import { LockIcon, UsersIcon, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { setMachineSharing, type MachineSharing } from "@/lib/machines";
import { cn } from "@/lib/utils";

export const SHARING_ICONS: Record<MachineSharing, LucideIcon> = {
  only_me: LockIcon,
  anyone: UsersIcon,
};

/** The card's short policy label, from the viewer's side: "Only your jobs" on your own machine. */
export function sharingLabel(sharing: MachineSharing, mine: boolean) {
  if (sharing === "anyone") return "Any job";
  return mine ? "Only your jobs" : "Only their jobs";
}

const OPTIONS: { value: MachineSharing; title: string; detail: string }[] = [
  {
    value: "only_me",
    title: "Only me",
    detail: "Runs jobs you start. Teammates' jobs, bots and scheduled runs skip it.",
  },
  {
    value: "anyone",
    title: "Any job",
    detail: "Runs any job routed here, including teammates', bots and scheduled runs.",
  },
];

/** Who can run jobs on a machine: its owner picks Only me or Any job (#243). */
export function SharingDialog({
  machineId,
  machineName,
  sharing,
  open,
  onOpenChange,
}: {
  machineId: string;
  machineName: string;
  sharing: MachineSharing;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [choice, setChoice] = useState(sharing);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function change(next: boolean) {
    if (pending) return;
    if (next) {
      setChoice(sharing);
      setError(null);
    }
    onOpenChange(next);
  }

  async function save() {
    if (choice === sharing) return change(false);
    setPending(true);
    setError(null);
    try {
      await setMachineSharing(machineId, choice);
      await router.invalidate();
      setPending(false);
      onOpenChange(false);
    } catch {
      setError("Couldn't save. Try again.");
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="pr-6 break-words">
            Who can run jobs on <span className="font-mono">{machineName}</span>?
          </DialogTitle>
          <DialogDescription>
            A job belongs to whoever started the run. Jobs this machine won't take go to the next
            Router step.
          </DialogDescription>
        </DialogHeader>
        <div role="radiogroup" aria-label="Who can run jobs here" className="grid gap-2">
          {OPTIONS.map((option) => {
            const Icon = SHARING_ICONS[option.value];
            const on = choice === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={pending}
                onClick={() => setChoice(option.value)}
                className={cn(
                  "flex gap-3 rounded-lg border px-3 py-3 text-left text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  on ? "border-go/60 bg-go/5" : "hover:bg-accent/60",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                    on ? "border-go" : "border-input",
                  )}
                >
                  {on && <span className="size-2 rounded-full bg-go" />}
                </span>
                <span className="grid gap-0.5">
                  <span className="flex items-center gap-1.5 font-medium">
                    <Icon aria-hidden className="size-3.5 text-muted-foreground" />
                    {option.title}
                  </span>
                  <span className="text-muted-foreground">{option.detail}</span>
                </span>
              </button>
            );
          })}
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter className="items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">Only you can change this.</p>
          <div className="flex gap-2 max-sm:w-full max-sm:[&>*]:flex-1">
            <Button variant="ghost" disabled={pending} onClick={() => change(false)}>
              Cancel
            </Button>
            <Button disabled={pending} onClick={() => void save()}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
