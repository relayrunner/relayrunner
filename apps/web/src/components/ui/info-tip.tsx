import { InfoIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** A small ⓘ that explains how a number is worked out. Opens on click, so it works on phones. */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger
        aria-label={`About ${label}`}
        className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <InfoIcon aria-hidden className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent className="grid w-80 gap-2 text-sm font-normal whitespace-normal text-muted-foreground [&_strong]:font-medium [&_strong]:text-foreground">
        {children}
      </PopoverContent>
    </Popover>
  );
}
