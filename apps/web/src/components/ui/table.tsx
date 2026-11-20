import * as React from "react";
import { cn } from "@/lib/utils";

// shadcn's table primitives, restyled to match the dashboard's existing tables:
// a bordered card, muted header row and hairline row dividers. Cells pad less on phones.

/** A table cell or header that phones leave out, for a figure the row or page already gives. */
const PHONE_HIDDEN = "hidden sm:table-cell";

function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div data-slot="table-container" className="overflow-x-auto rounded-xl border bg-card">
      <table data-slot="table" className={cn("w-full text-sm", className)} {...props} />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("text-muted-foreground [&_tr]:border-b", className)}
      {...props}
    />
  );
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return <tr data-slot="table-row" className={cn("border-b", className)} {...props} />;
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      scope="col"
      className={cn("px-3 py-2 text-left font-normal whitespace-nowrap sm:px-4", className)}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return <td data-slot="table-cell" className={cn("px-3 py-2.5 sm:px-4", className)} {...props} />;
}

function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("px-3 pt-3 pb-2 text-left font-semibold sm:px-4", className)}
      {...props}
    />
  );
}

export {
  PHONE_HIDDEN,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
};
