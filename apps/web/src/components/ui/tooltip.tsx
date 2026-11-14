import { Tooltip as TooltipPrimitive } from "radix-ui";
import * as React from "react";
import { cn } from "@/lib/utils";

function TooltipProvider({
  delayDuration = 150,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  );
}

/** Lets a tap toggle the tooltip: Radix opens tooltips on hover and focus only, so touch gets none. */
const TapContext = React.createContext<{ open: boolean; setOpen: (open: boolean) => void } | null>(
  null,
);

function Tooltip({
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const [openState, setOpenState] = React.useState(defaultOpen);
  const open = openProp ?? openState;
  const setOpen = React.useCallback(
    (next: boolean) => {
      setOpenState(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );
  const tap = React.useMemo(() => ({ open, setOpen }), [open, setOpen]);
  return (
    <TapContext.Provider value={tap}>
      <TooltipPrimitive.Root data-slot="tooltip" open={open} onOpenChange={setOpen} {...props} />
    </TapContext.Provider>
  );
}

function TooltipTrigger({
  onPointerDown,
  onClick,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  const tap = React.useContext(TapContext);
  // Whether the last press was a touch, and whether the tooltip was open when it began.
  const press = React.useRef({ touch: false, wasOpen: false });
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      onPointerDown={(event) => {
        press.current = { touch: event.pointerType !== "mouse", wasOpen: tap?.open ?? false };
        onPointerDown?.(event);
      }}
      onClick={(event) => {
        onClick?.(event);
        if (!press.current.touch || !tap) return;
        // Radix closes the tooltip on every click; a tap toggles it instead.
        event.preventDefault();
        tap.setOpen(!press.current.wasOpen);
      }}
      {...props}
    />
  );
}

function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-fit rounded-md border bg-popover px-2.5 py-1.5 text-xs font-medium text-popover-foreground shadow-md",
          "animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          className,
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
