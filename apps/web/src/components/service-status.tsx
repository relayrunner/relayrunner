import { useQuery } from "@tanstack/react-query";
import { ArrowUpRightIcon } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

export const STATUS_URL = "https://status.relayrunner.dev";

export type ServiceState = "operational" | "degraded" | "downtime" | "maintenance";

export type ServiceStatus = { state: ServiceState; incident?: string };

const LABELS: Record<ServiceState, string> = {
  operational: "All systems operational",
  degraded: "Degraded performance",
  downtime: "Outage",
  maintenance: "Maintenance",
};

const DOT: Record<ServiceState, string> = {
  operational: "bg-go",
  degraded: "bg-run",
  downtime: "bg-destructive",
  maintenance: "bg-run",
};

/** How often an open dashboard asks again. The API caches Better Stack's answer for a minute. */
const REFRESH_MS = 120_000;

/**
 * RelayRunner's own status from GET /api/status (status.relayrunner.dev, read by the API). Until
 * the first answer, and when the status page can't be read, it reads as operational: a missing
 * status never puts a banner up.
 */
export function useServiceStatus(): ServiceStatus {
  const { data } = useQuery({
    queryKey: ["service-status"],
    queryFn: () => api<{ state: ServiceState | null; incident: string | null }>("/status"),
    refetchInterval: REFRESH_MS,
    staleTime: REFRESH_MS / 2,
  });
  // A state this build doesn't know reads as operational too, rather than a blank label.
  if (!data?.state || !(data.state in LABELS)) return { state: "operational" };
  return { state: data.state, incident: data.incident ?? undefined };
}

export function StatusDot({ state, className }: { state: ServiceState; className?: string }) {
  return (
    <span aria-hidden className={cn("relative flex size-2 shrink-0", className)}>
      {state !== "operational" && (
        <span className={cn("absolute inset-0 animate-ping rounded-full opacity-60", DOT[state])} />
      )}
      <span className={cn("relative size-2 rounded-full", DOT[state])} />
    </span>
  );
}

/** The sidebar's status row: a dot and the short state, linking to the status page. */
export function StatusLink({ className }: { className?: string }) {
  const { state } = useServiceStatus();
  const label = state === "operational" ? "Status" : LABELS[state];
  return (
    <a
      href={STATUS_URL}
      title={LABELS[state]}
      className={cn(className, state !== "operational" && "text-sidebar-accent-foreground")}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        <StatusDot state={state} />
      </span>
      <span className="group-data-[collapsed]/sidebar:sr-only">{label}</span>
    </a>
  );
}

/** A thin bar over every page while something is wrong, with the incident's title. */
export function StatusBanner() {
  const { state, incident } = useServiceStatus();
  if (state === "operational") return null;
  return (
    <a
      href={STATUS_URL}
      className={cn(
        "flex items-center gap-2.5 border-b px-4 py-2 text-[13px] transition-colors sm:px-8",
        state === "downtime"
          ? "border-destructive/30 bg-destructive/10 hover:bg-destructive/15"
          : "border-run/30 bg-run/10 hover:bg-run/15",
      )}
    >
      <StatusDot state={state} />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium">{LABELS[state]}</span>
        {incident && <span className="text-muted-foreground"> · {incident}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
        Status page
        <ArrowUpRightIcon aria-hidden className="size-3.5" />
      </span>
    </a>
  );
}
