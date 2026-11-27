import { CheckIcon, ClipboardCopyIcon, DownloadIcon, FileJsonIcon, SheetIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { downloadRows, type ExportMenuProps, toMarkdown } from "@/lib/table-export";
import { useCopy } from "@/lib/use-copy";

/** The Export menu itself, loaded on demand by `ExportMenu`. */
export default function ExportMenuDropdown<TData>({ name, rows, columns }: ExportMenuProps<TData>) {
  const { copied, copy } = useCopy(() => toMarkdown(rows(), columns));

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
