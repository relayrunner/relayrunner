import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/**
 * Type-the-name confirm for the operator deletes on /admin, which exist to repeat new-user signup
 * and onboarding tests. Offers to uninstall the GitHub App when there are accounts to uninstall
 * from, off by default since it's the one step that changes something on GitHub.
 */
export function AdminDeleteDialog({
  open,
  onOpenChange,
  title,
  children,
  confirmText,
  githubAccounts,
  blocked,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  /** What the operator types to enable Delete. */
  confirmText: string;
  githubAccounts: string[];
  /** Why the delete can't go ahead, shown instead of the controls. */
  blocked?: ReactNode;
  onConfirm: (uninstallGitHubApp: boolean) => Promise<void>;
}) {
  const [typed, setTyped] = useState("");
  const [uninstall, setUninstall] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function change(next: boolean) {
    if (pending) return;
    if (!next) {
      setTyped("");
      setUninstall(false);
      setError(null);
    }
    onOpenChange(next);
  }

  async function confirm() {
    setPending(true);
    setError(null);
    try {
      await onConfirm(uninstall);
      setPending(false);
      change(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription asChild>
            <div className="grid gap-2">{children}</div>
          </DialogDescription>
        </DialogHeader>
        {blocked ? (
          <p className="text-sm">{blocked}</p>
        ) : (
          <div className="grid gap-3">
            {githubAccounts.length > 0 && (
              <label className="flex cursor-pointer gap-3 rounded-lg border px-3 py-3 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 accent-[var(--color-destructive)]"
                  checked={uninstall}
                  disabled={pending}
                  onChange={(e) => setUninstall(e.target.checked)}
                />
                <span className="grid gap-1">
                  <span className="font-medium">
                    Also uninstall the GitHub App from {githubAccounts.join(", ")}
                  </span>
                  <span className="text-muted-foreground">
                    For a clean re-test: the next sign-up sees GitHub's first-install screen. Left
                    off, the install stays as an unclaimed connection.
                  </span>
                </span>
              </label>
            )}
            <label className="grid gap-1.5 text-sm">
              <span>
                Type <span className="font-mono font-medium">{confirmText}</span> to confirm
              </span>
              <Input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                disabled={pending}
              />
            </label>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" disabled={pending} onClick={() => change(false)}>
            Cancel
          </Button>
          {!blocked && (
            <Button
              variant="destructive"
              disabled={pending || typed.trim() !== confirmText}
              onClick={() => void confirm()}
            >
              {pending ? "Deleting…" : "Delete"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
