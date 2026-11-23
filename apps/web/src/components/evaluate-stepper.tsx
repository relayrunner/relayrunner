// The steps of evaluating a provider, shown on the public start page (routes/evaluate.$provider.tsx)
// and the dashboard's Evaluate page. Connecting GitHub is the first step, so someone who starts
// from the site sees signing in as part of the evaluation rather than a separate sign-up.
import { CheckIcon } from "lucide-react";
import { providerInfo } from "@/lib/provider-catalog";
import { cn } from "@/lib/utils";

export const EVALUATE_STEP = {
  github: 0,
  provider: 1,
  choose: 2,
  run: 3,
} as const;

export function EvaluateStepper({ at, provider }: { at: number; provider: string }) {
  const steps = [
    "Connect GitHub",
    `Connect ${providerInfo(provider).name}`,
    "Choose a workflow",
    "Run and compare",
  ];
  return (
    <ol className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
      {steps.map((label, i) => (
        <li key={label} className="flex items-center gap-3">
          <span
            className={cn(
              "flex items-center gap-2",
              i > at ? "text-muted-foreground" : "font-medium",
            )}
          >
            <span
              className={cn(
                "flex size-5 items-center justify-center rounded-full border text-xs tabular-nums",
                i < at && "border-go-edge bg-go-soft text-go",
                i === at && "border-foreground bg-foreground text-background",
              )}
            >
              {i < at ? <CheckIcon aria-label="Done" className="size-3" /> : i + 1}
            </span>
            {label}
          </span>
          {i < steps.length - 1 && (
            <span aria-hidden className="hidden h-px w-8 bg-border sm:block" />
          )}
        </li>
      ))}
    </ol>
  );
}
