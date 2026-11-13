import type { RetryRunner, RetrySettings } from "@relayrunner/runner-order";
import { useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getRetrySettings, setRetrySettings } from "@/lib/retry-settings";
import { cn } from "@/lib/utils";

const RUNNERS: { value: RetryRunner; label: string }[] = [
  { value: "any", label: "Any runner" },
  { value: "same", label: "The same runner" },
  { value: "other", label: "A different runner" },
];

// The workspace's automatic retries, saved on each change. Nothing until the settings load.
export function RetrySettingsCard({
  workspaceId,
  editable,
}: {
  workspaceId: string;
  editable: boolean;
}) {
  const [settings, setSettings] = useState<RetrySettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    getRetrySettings(workspaceId).then(
      (loaded) => live && setSettings(loaded),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [workspaceId]);
  if (!settings) return null;

  async function save(next: RetrySettings) {
    const before = settings;
    setSettings(next);
    setSaving(true);
    setFailed(false);
    try {
      await setRetrySettings(workspaceId, next);
    } catch {
      setSettings(before);
      setFailed(true);
    } finally {
      setSaving(false);
    }
  }

  const disabled = !editable || saving;
  return (
    <div className="grid gap-3 rounded-xl border px-4 py-3 text-sm">
      <label className={cn("flex gap-3", editable && "cursor-pointer")}>
        <input
          type="checkbox"
          className="mt-0.5 size-4 accent-[var(--color-go)]"
          checked={settings.enabled}
          disabled={disabled}
          onChange={(event) => void save({ ...settings, enabled: event.target.checked })}
        />
        <span className="grid gap-1">
          <span className="font-medium">Retry jobs when their runner fails</span>
          <span className="text-muted-foreground">
            When a job fails because its runner never started it, went offline, or lost touch with
            GitHub, the Router re-runs it after the run finishes. A job whose own steps failed is
            never retried. A repo can turn this on or off with <code>retry</code> in its
            relayrunner.yml.
          </span>
        </span>
      </label>
      {settings.enabled && (
        <div className="flex flex-wrap gap-4 pl-7">
          <div className="grid gap-1.5">
            <span className="text-muted-foreground">Send the retry to</span>
            <Select
              value={settings.runner}
              disabled={disabled}
              onValueChange={(runner) => void save({ ...settings, runner: runner as RetryRunner })}
            >
              <SelectTrigger className="w-48" aria-label="Send the retry to">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RUNNERS.map((runner) => (
                  <SelectItem key={runner.value} value={runner.value}>
                    {runner.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <span className="text-muted-foreground">Retries per run</span>
            <Select
              value={String(settings.max)}
              disabled={disabled}
              onValueChange={(max) => void save({ ...settings, max: Number(max) })}
            >
              <SelectTrigger className="w-24" aria-label="Retries per run">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">1</SelectItem>
                <SelectItem value="2">2</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      )}
      {failed && <span className="text-destructive">Couldn't save. Try again.</span>}
    </div>
  );
}
