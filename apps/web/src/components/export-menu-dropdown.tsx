import { CheckIcon, ClipboardCopyIcon, DownloadIcon, FileJsonIcon, SheetIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { downloadRows, type ExportColumn, toMarkdown } from "@/lib/table-export";

/** The Export menu itself, loaded on demand by `ExportMenu`. */
export default function ExportMenuDropdown<TData>({
  name,
  rows,
  columns,
}: {
  name: string;
  rows: () => TData[];
  columns: ExportColumn<TData>[];
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(toMarkdown(rows(), columns));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" className="text-muted-foreground">
          {copied ? <CheckIcon aria-hidden /> : <DownloadIcon aria-hidden />}
          {copied ? "Copied" : "Export"}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => downloadRows("csv", name, rows(), columns)}>
          <SheetIcon aria-hidden />
          Download CSV
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => downloadRows("json", name, rows(), columns)}>
          <FileJsonIcon aria-hidden />
          Download JSON
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void copy()}>
          <ClipboardCopyIcon aria-hidden />
          Copy as Markdown
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
