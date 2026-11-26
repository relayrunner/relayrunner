import { DownloadIcon } from "lucide-react";
import { lazy, Suspense } from "react";
import { Button } from "@/components/ui/button";
import type { ExportColumn } from "@/lib/table-export";

// The menu and its formats load with the first table that shows it, not with the app.
const ExportMenuDropdown = lazy(() => import("./export-menu-dropdown"));

/**
 * Saves or copies the rows a table shows, as they're filtered and sorted: CSV for a spreadsheet,
 * JSON for a script, Markdown to paste into a chat with a teammate or an agent. `rows` is called
 * when a format is picked, so the table only works them out then. `name` starts the file's name.
 */
export function ExportMenu<TData>(props: {
  name: string;
  rows: () => TData[];
  columns: ExportColumn<TData>[];
}) {
  return (
    <Suspense
      fallback={
        <Button size="sm" variant="ghost" className="text-muted-foreground" disabled>
          <DownloadIcon aria-hidden />
          Export
        </Button>
      }
    >
      <ExportMenuDropdown {...(props as Parameters<typeof ExportMenuDropdown>[0])} />
    </Suspense>
  );
}
