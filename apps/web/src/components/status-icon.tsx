import {
  CheckIcon,
  CircleDashedIcon,
  CircleSlashIcon,
  LoaderCircleIcon,
  MinusIcon,
} from "lucide-react";
import type { ComponentType } from "react";
import { cn } from "@/lib/utils";

type IconProps = { className?: string; role?: string; "aria-label"?: string };

/** A solid red disc with a cross knocked out of it: the one result meant to catch the eye. */
function FailedIcon({ className, ...props }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...props}>
      <circle cx="12" cy="12" r="10.5" fill="currentColor" />
      <path
        d="m15 9-6 6m0-6 6 6"
        className="stroke-background"
        strokeWidth={2.5}
        strokeLinecap="round"
      />
    </svg>
  );
}

type Status = { Icon: ComponentType<IconProps>; label: string; className: string };
const QUIET = "text-muted-foreground";
const FAILED: Status = { Icon: FailedIcon, label: "Failed", className: "text-destructive" };
const CANCELLED: Status = { Icon: CircleSlashIcon, label: "Cancelled", className: QUIET };
const STATUS: Record<string, Status> = {
  in_progress: { Icon: LoaderCircleIcon, label: "In progress", className: "animate-spin text-run" },
  queued: { Icon: CircleDashedIcon, label: "Queued", className: QUIET },
  success: { Icon: CheckIcon, label: "Passed", className: QUIET },
  failure: FAILED,
  timed_out: { ...FAILED, label: "Timed out" },
  cancelled: CANCELLED,
  skipped: { Icon: MinusIcon, label: "Skipped", className: QUIET },
};

/**
 * A run's, job's, step's or check's result as an icon. A pass is a quiet grey tick and a failure a
 * solid red disc, so a list of mostly passing jobs reads calm and the failures stand out.
 */
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
