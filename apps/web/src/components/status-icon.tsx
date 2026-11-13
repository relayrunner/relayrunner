import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleSlashIcon,
  CircleXIcon,
  LoaderCircleIcon,
  type LucideIcon,
  TimerOffIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

type Status = { Icon: LucideIcon; label: string; className: string };
const CANCELLED: Status = {
  Icon: CircleSlashIcon,
  label: "Cancelled",
  className: "text-muted-foreground",
};
const STATUS: Record<string, Status> = {
  in_progress: { Icon: LoaderCircleIcon, label: "In progress", className: "animate-spin text-run" },
  queued: { Icon: CircleDashedIcon, label: "Queued", className: "text-muted-foreground" },
  success: { Icon: CircleCheckIcon, label: "Succeeded", className: "text-go" },
  failure: { Icon: CircleXIcon, label: "Failed", className: "text-destructive" },
  timed_out: { Icon: TimerOffIcon, label: "Timed out", className: "text-destructive" },
  cancelled: CANCELLED,
  skipped: { ...CANCELLED, label: "Skipped" },
};

/** A run's, job's or step's result as an icon: a tick, a cross, a spinner while it runs. */
export function StatusIcon({
  status,
  conclusion,
  className,
}: {
  status: string;
  conclusion: string | null;
  className?: string;
}) {
  const shown = STATUS[status === "completed" ? (conclusion ?? "") : status] ?? {
    ...CANCELLED,
    label: conclusion ?? "Finished",
  };
  return (
    <shown.Icon
      role="img"
      aria-label={shown.label}
      className={cn("size-[18px] shrink-0", shown.className, className)}
    />
  );
}
