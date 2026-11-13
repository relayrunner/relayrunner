import * as React from "react";
import { XIcon } from "lucide-react";
import { Dialog as SheetPrimitive } from "radix-ui";
import { DialogOverlay, DialogPortal } from "@/components/ui/dialog";
import { readNumber, saveNumber } from "@/lib/stored-flag";
import { cn } from "@/lib/utils";

/** A panel that slides in from the right edge over the page, for a row's detail. */
function Sheet({ ...props }: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

// A resized panel stays at least this wide, and leaves this much of the page showing.
const MIN_WIDTH = 420;
const PAGE_LEFT = 48;
const KEY_STEP = 32;

const clampWidth = (width: number) =>
  Math.round(Math.max(MIN_WIDTH, Math.min(width, window.innerWidth - PAGE_LEFT)));

/**
 * With `widthKey`, the panel's left edge can be dragged (or moved with the arrow keys) to resize
 * it, and the width is kept in this browser under that key. A double-click puts it back.
 */
function SheetContent({
  className,
  children,
  widthKey,
  style,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & { widthKey?: string }) {
  const [width, setWidth] = React.useState(() => (widthKey ? readNumber(widthKey) : null));
  const ref = React.useRef<HTMLDivElement>(null);
  const resize = (next: number | null, save = true) => {
    const value = next === null ? null : clampWidth(next);
    setWidth(value);
    if (save && widthKey) saveNumber(widthKey, value);
  };
  const current = () => width ?? ref.current?.getBoundingClientRect().width ?? MIN_WIDTH;

  return (
    <DialogPortal>
      <DialogOverlay />
      <SheetPrimitive.Content
        ref={ref}
        data-slot="sheet-content"
        className={cn(
          "fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l bg-background shadow-lg duration-200 data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right data-[state=open]:animate-in data-[state=open]:slide-in-from-right sm:max-w-2xl",
          width !== null && "sm:w-(--sheet-width) sm:max-w-[calc(100vw-3rem)]",
          className,
        )}
        style={width === null ? style : { ...style, ["--sheet-width" as string]: `${width}px` }}
        {...props}
      >
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        <SheetPrimitive.Close className="absolute top-4 right-4 rounded-xs p-1 opacity-70 transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden">
          <XIcon className="size-4" />
          <span className="sr-only">Close</span>
        </SheetPrimitive.Close>
        {/* Last, so opening the panel focuses the content or the close button first. */}
        {widthKey && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize panel"
            aria-valuenow={Math.round(current())}
            tabIndex={0}
            className="absolute inset-y-0 left-0 z-10 hidden w-1.5 cursor-col-resize transition-colors hover:bg-border focus-visible:bg-ring focus-visible:outline-hidden sm:block"
            onPointerDown={(event) => {
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                resize(window.innerWidth - event.clientX, false);
            }}
            onPointerUp={() => width !== null && resize(width)}
            onDoubleClick={() => resize(null)}
            onKeyDown={(event) => {
              const step = { ArrowLeft: KEY_STEP, ArrowRight: -KEY_STEP }[event.key];
              if (step === undefined) return;
              event.preventDefault();
              resize(current() + step);
            }}
          />
        )}
      </SheetPrimitive.Content>
    </DialogPortal>
  );
}

function SheetTitle({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn("text-lg leading-tight font-semibold", className)}
      {...props}
    />
  );
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export { Sheet, SheetContent, SheetDescription, SheetTitle };
