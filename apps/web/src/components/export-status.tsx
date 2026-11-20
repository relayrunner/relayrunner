import { CheckIcon } from "lucide-react";
import { timeAgo } from "@/lib/activity";
import type { ExportStatus as Status } from "@/lib/telemetry";

/** Whether an export on Settings → Telemetry is sending, and what went wrong when it isn't. */
export function ExportStatus({
  status,
  on,
  off,
  sent,
  waiting,
}: {
  status: Status;
  // What it says while sending ("Sending traces."), or null when nothing is on.
  on: string | null;
  // What it says when off, after it last sent ("Last sent"), and before it has.
  off: string;
  sent: string;
  waiting: string;
}) {
  const { lastSentAt, error, failingSince, pausedAt, logs, logsSkipped } = status;
  return (
    <div role="status" className="grid gap-1 text-sm">
      {pausedAt ? (
        <p className="text-destructive">
          Paused {timeAgo(pausedAt)} after three days of errors. Fix the settings and save to start
          again.
        </p>
      ) : !on ? (
        <p className="text-muted-foreground">{off}</p>
      ) : (
        <p className="flex items-center gap-1 text-muted-foreground">
          <CheckIcon aria-hidden className="size-4 text-go" />
          {on} {lastSentAt ? `${sent} ${timeAgo(lastSentAt)}.` : waiting}
        </p>
      )}
      {logs !== "off" && logsSkipped && (
        <p className="text-muted-foreground">
          Skipped a job's log {timeAgo(logsSkipped.at)}: {logsSkipped.reason}.
        </p>
      )}
      {error && (
        <p className="text-destructive">
          {failingSince ? `Failing since ${timeAgo(failingSince)}: ` : "Last error: "}
          {error}
        </p>
      )}
    </div>
  );
}
