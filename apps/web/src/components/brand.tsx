import { cn } from "@/lib/utils";

/** The relayrunner runner-head mark and wordmark, as on the main site's header. */
export function Brand({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2.5 text-xl font-bold tracking-[-0.01em]",
        className,
      )}
    >
      <img src="/runner-head.svg" alt="" className="size-[26px] shrink-0" />
      relayrunner
    </span>
  );
}
