import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
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
 * from, on by default so the next sign-up starts clean. The value to type copies on click, and
 * Enter in the field submits once it matches.
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
  const [uninstall, setUninstall] = useState(true);
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function change(next: boolean) {
    if (pending) return;
    if (!next) {
      setTyped("");
      setUninstall(true);
      setCopied(false);
      setError(null);
    }
    onOpenChange(next);
  }

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(confirmText);
      setCopied(true);
    } catch {
      // Clipboard can be blocked; the value is still there to type.
    }
  }

  const matches = typed.trim() === confirmText;

  async function confirm() {
    if (pending || blocked || !matches) return;
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
          <form
            id="admin-delete-form"
            className="grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void confirm();
            }}
          >
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
                Type{" "}
                <button
                  type="button"
                  onClick={() => void copy()}
                  title="Copy"
                  className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono font-medium hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {confirmText}
                  {copied ? (
                    <CheckIcon aria-hidden className="size-3.5 text-muted-foreground" />
                  ) : (
                    <CopyIcon aria-hidden className="size-3.5 text-muted-foreground" />
                  )}
                  <span className="sr-only">{copied ? "Copied" : "Copy"}</span>
                </button>{" "}
                to confirm
              </span>
              <Input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                disabled={pending}
              />
            </label>
          </form>
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
              type="submit"
              form="admin-delete-form"
              variant="destructive"
              disabled={pending || !matches}
            >
              {pending ? "Deleting…" : "Delete"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
