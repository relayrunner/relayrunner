import { useEffect, useState } from "react";
import { LaptopIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { deviceName } from "@/lib/device";
import { addMachinesToWorkspace, type OtherMachine } from "@/lib/machines";
import { cn } from "@/lib/utils";

const OS_NAMES = { linux: "Linux", macos: "macOS", windows: "Windows" } as const;
const SHARING = { only_me: "Only your jobs", anyone: "Any job" } as const;

/**
 * Above the Runners page when some of the signed-in user's own machines don't take this
 * workspace's jobs: a workspace they joined through GitHub starts with none of them. Dismissing it
 * hides it; the Add runner menu still opens the same dialog.
 */
export function OtherMachinesBanner({
  workspace,
  others,
  onChoose,
  onDismiss,
}: {
  workspace: string;
  others: OtherMachine[];
  onChoose: () => void;
  onDismiss: () => void;
}) {
  if (others.length === 0) return null;
  const one = others.length === 1;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-card px-4 py-2.5 text-sm"
    >
      <LaptopIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <p className="min-w-0 flex-1 basis-56">
        {one ? (
          <>
            Your machine <span className="font-mono">{others[0]!.name}</span> doesn't run{" "}
            <span className="font-mono">{workspace}</span> jobs.
          </>
        ) : (
          <>
            {others.length} of your machines don't run{" "}
            <span className="font-mono">{workspace}</span> jobs.
          </>
        )}{" "}
        <span className="text-muted-foreground">Only you see this.</span>
      </p>
      <div className="ml-auto flex items-center gap-1">
        <Button size="sm" variant="outline" onClick={onChoose}>
          {one ? "Add it" : "Choose machines"}
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          className="-mr-2 shrink-0 text-muted-foreground"
          aria-label="Dismiss"
          onClick={onDismiss}
        >
          <XIcon aria-hidden />
        </Button>
      </div>
    </div>
  );
}

/** Picks which of the user's other machines to add to this workspace. */
export function OtherMachinesDialog({
  open,
  onOpenChange,
  workspace,
  others,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspace: string;
  others: OtherMachine[];
  onAdded: () => void | Promise<void>;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setPicked(new Set());
    setError(null);
  }, [open]);

  function toggle(id: string) {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function add() {
    setAdding(true);
    setError(null);
    try {
      await addMachinesToWorkspace([...picked]);
      await onAdded();
      onOpenChange(false);
    } catch {
      setError("Couldn't add the machines. Try again.");
    } finally {
      setAdding(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add your machines</DialogTitle>
          <DialogDescription>
            Machines you've connected that don't run <span className="font-mono">{workspace}</span>{" "}
            jobs yet. Adding one lets it take this workspace's jobs, as its sharing allows.
          </DialogDescription>
        </DialogHeader>
        {others.length === 0 ? (
          <p className="text-sm text-muted-foreground">All your machines already run jobs here.</p>
        ) : (
          <div className="grid gap-2">
            {others.map((machine) => {
              const checked = picked.has(machine.id);
              const model = machine.device ? deviceName(machine.device) : null;
              const os = machine.device?.osVersion ?? (machine.os ? OS_NAMES[machine.os] : null);
              return (
                <label
                  key={machine.id}
                  className={cn(
                    "flex cursor-pointer gap-3 rounded-lg border px-3 py-3 text-sm hover:bg-accent/40",
                    checked && "border-go-edge bg-go-soft",
                  )}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4 accent-[var(--color-go)]"
                    checked={checked}
                    onChange={() => toggle(machine.id)}
                  />
                  <span className="grid min-w-0 flex-1 gap-1">
                    <span className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono">{machine.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {machine.online ? "Online" : "Offline"}
                      </span>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {[model, os, SHARING[machine.sharing]].filter(Boolean).join(" · ")}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {machine.workspaces.length > 0
                        ? `Runs jobs in ${machine.workspaces.join(", ")}`
                        : "Not in any workspace"}
                    </span>
                  </span>
                </label>
              );
            })}
            {others.some((machine) => machine.sharing === "anyone") && (
              <p className="text-xs text-muted-foreground">
                A machine set to Any job takes jobs from anyone who can push to this workspace's
                private repos.
              </p>
            )}
          </div>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {others.length > 0 && (
            <Button disabled={picked.size === 0 || adding} onClick={() => void add()}>
              {adding
                ? "Adding…"
                : picked.size === 0
                  ? "Add machines"
                  : `Add ${picked.size} ${picked.size === 1 ? "machine" : "machines"}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
