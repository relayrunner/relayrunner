import {
  columnFilteringFeature,
  createColumnHelper,
  createFilteredRowModel,
  createExpandedRowModel,
  createSortedRowModel,
  type ExpandedState,
  FlexRender,
  filterFn_includesString,
  globalFilteringFeature,
  metaHelper,
  type OnChangeFn,
  type Row,
  type RowData,
  rowExpandingFeature,
  rowSortingFeature,
  sortFn_basic,
  sortFn_text,
  type SortingState,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon } from "lucide-react";
import {
  createContext,
  memo,
  type ReactNode,
  use,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { InfoTip } from "@/components/ui/info-tip";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

type ColumnMeta = {
  /** Right-align numbers so their digits line up. */
  align?: "end";
  /** Classes for this column's body cells. */
  className?: string;
  /** How the column is worked out, behind an ⓘ beside its header. */
  info?: ReactNode;
  /** The ⓘ's name for a header that isn't plain text. */
  label?: string;
};

const features = tableFeatures({
  rowSortingFeature,
  columnFilteringFeature,
  globalFilteringFeature,
  rowExpandingFeature,
  expandedRowModel: createExpandedRowModel(),
  sortedRowModel: createSortedRowModel(),
  filteredRowModel: createFilteredRowModel(),
  sortFns: { basic: sortFn_basic, text: sortFn_text },
  filterFns: { includesString: filterFn_includesString },
  columnMeta: metaHelper<ColumnMeta>(),
});

/** Column helper bound to DataTable's features. Define columns at module scope. */
export function dataTableColumns<TData extends RowData>() {
  return createColumnHelper<typeof features, TData>();
}

export type { ExpandedState };
export type DataTableRow<TData extends RowData> = Row<typeof features, TData>;

type Columns<TData extends RowData> = ReturnType<
  ReturnType<typeof dataTableColumns<TData>>["columns"]
>;

/**
 * Hands page state and callbacks to cells, so columns can stay at module scope (a new columns
 * array each render would rebuild the table). Wrap the DataTable in the returned Provider.
 */
export function createCellContext<T>(name: string) {
  const Context = createContext<T | null>(null);
  function useCellContext() {
    const value = use(Context);
    if (value === null) throw new Error(`${name} cells render inside its Provider`);
    return value;
  }
  return [Context.Provider, useCellContext] as const;
}

/** Meta for a numeric column: right-aligned and muted, like the dashboard's other figures. */
export const NUM: ColumnMeta = {
  align: "end",
  className: "whitespace-nowrap text-muted-foreground",
};

const ARIA_SORT = { asc: "ascending", desc: "descending" } as const;

// Below this many rows every row renders. Above it, only the rows near the viewport do.
const VIRTUALIZE_ABOVE = 100;

export function DataTable<TData extends RowData>({
  columns,
  data,
  getRowId,
  search = "",
  initialSorting = [],
  caption,
  empty = "Nothing to show.",
  rowHeight = 45,
  getSubRows,
  expanded,
  onExpandedChange,
  rowClassName,
}: {
  columns: Columns<TData>;
  data: TData[];
  getRowId: (row: TData) => string;
  /** Keeps rows where any searchable column contains this text. */
  search?: string;
  initialSorting?: SortingState;
  caption?: ReactNode;
  empty?: ReactNode;
  /** A typical row's height in pixels, used to place rows before they're measured. */
  rowHeight?: number;
  /** Nested rows. They sort within their parent and show while it's expanded. */
  getSubRows?: (row: TData) => TData[] | undefined;
  expanded?: ExpandedState;
  onExpandedChange?: OnChangeFn<ExpandedState>;
  rowClassName?: (row: Row<typeof features, TData>) => string | undefined;
}) {
  const [sorting, setSorting] = useState(initialSorting);
  const table = useTable({
    features,
    columns,
    data,
    getRowId,
    getSubRows,
    state: { sorting, globalFilter: search, ...(expanded && { expanded }) },
    onSortingChange: setSorting,
    onExpandedChange,
    globalFilterFn: "includesString",
    // Missing values (no runs yet, no price) sort after real ones either way.
    defaultColumn: { sortUndefined: "last" },
  });
  const rows = table.getRowModel().rows;
  const headers = table.getHeaderGroups()[0]?.headers ?? [];

  return (
    <Table className="tabular-nums">
      {caption && <TableCaption>{caption}</TableCaption>}
      <TableHeader>
        <TableRow>
          {headers.map((header) => {
            const sorted = header.column.getIsSorted();
            const { align, info, label } = header.column.columnDef.meta ?? {};
            const title = header.column.columnDef.header;
            return (
              <TableHead
                key={header.id}
                aria-sort={sorted ? ARIA_SORT[sorted] : undefined}
                className={cn(align === "end" && "text-right")}
              >
                <span className="inline-flex items-center gap-1.5">
                  {header.column.getCanSort() ? (
                    <button
                      type="button"
                      onClick={header.column.getToggleSortingHandler()}
                      className={cn(
                        "group inline-flex items-center gap-1 rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                        // The arrow sits on the inner side, so labels line up with their column.
                        align === "end" && "flex-row-reverse",
                      )}
                    >
                      <FlexRender header={header} />
                      <SortIcon sorted={sorted} />
                    </button>
                  ) : (
                    <FlexRender header={header} />
                  )}
                  {info && (
                    <InfoTip label={label ?? (typeof title === "string" ? title : "this column")}>
                      {info}
                    </InfoTip>
                  )}
                </span>
              </TableHead>
            );
          })}
        </TableRow>
      </TableHeader>
      {rows.length === 0 ? (
        <TableBody>
          <TableRow>
            <TableCell colSpan={headers.length} className="py-6 text-muted-foreground">
              {empty}
            </TableCell>
          </TableRow>
        </TableBody>
      ) : rows.length > VIRTUALIZE_ABOVE ? (
        <VirtualRows
          rows={rows}
          columns={headers.length}
          rowHeight={rowHeight}
          rowClassName={rowClassName}
        />
      ) : (
        <TableBody>
          {rows.map((row) => (
            <DataRow
              key={row.id}
              row={row}
              expanded={row.getIsExpanded()}
              className={rowClassName?.(row)}
            />
          ))}
        </TableBody>
      )}
    </Table>
  );
}

type DataRowProps<TData extends RowData> = {
  row: Row<typeof features, TData>;
  /** Passed so a memoized row re-renders when it opens or closes. */
  expanded: boolean;
  className?: string;
  index?: number;
  measure?: (element: HTMLTableRowElement | null) => void;
};

// Memoized: rows re-render on scroll only when they enter the window, not every frame.
const DataRow = memo(function DataRow<TData extends RowData>({
  row,
  className,
  index,
  measure,
}: DataRowProps<TData>) {
  return (
    <TableRow data-index={index} ref={measure} className={className}>
      {row.getAllCells().map((cell) => (
        <TableCell
          key={cell.id}
          className={cn(
            cell.column.columnDef.meta?.align === "end" && "text-right",
            cell.column.columnDef.meta?.className,
          )}
        >
          <FlexRender cell={cell} />
        </TableCell>
      ))}
    </TableRow>
  );
}) as <TData extends RowData>(props: DataRowProps<TData>) => ReactNode;

// Window-scrolled rows with spacer rows above and below, so the markup stays a real <table>
// and columns keep their natural widths.
function VirtualRows<TData extends RowData>({
  rows,
  columns,
  rowHeight,
  rowClassName,
}: {
  rows: Row<typeof features, TData>[];
  columns: number;
  rowHeight: number;
  rowClassName?: (row: Row<typeof features, TData>) => string | undefined;
}) {
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const [offset, setOffset] = useState(0);
  useLayoutEffect(() => {
    const top = bodyRef.current?.getBoundingClientRect().top;
    if (top !== undefined) setOffset(top + window.scrollY);
  }, []);

  const virtualizer = useWindowVirtualizer({
    count: rows.length,
    estimateSize: useCallback(() => rowHeight, [rowHeight]),
    overscan: 10,
    scrollMargin: offset,
    // Stable between renders: the virtualizer re-measures every row when this changes.
    getItemKey: useCallback((index: number) => rows[index]!.id, [rows]),
  });
  const items = virtualizer.getVirtualItems();
  const before = items.length ? items[0]!.start - offset : 0;
  const after = items.length ? virtualizer.getTotalSize() - (items.at(-1)!.end - offset) : 0;

  return (
    <TableBody ref={bodyRef}>
      {before > 0 && <Spacer height={before} columns={columns} />}
      {items.map((item) => {
        const row = rows[item.index]!;
        return (
          <DataRow
            key={item.key}
            row={row}
            expanded={row.getIsExpanded()}
            className={rowClassName?.(row)}
            index={item.index}
            measure={virtualizer.measureElement}
          />
        );
      })}
      {after > 0 && <Spacer height={after} columns={columns} />}
    </TableBody>
  );
}

function Spacer({ height, columns }: { height: number; columns: number }) {
  return (
    <tr aria-hidden className="border-0">
      <td colSpan={columns} style={{ height, padding: 0 }} />
    </tr>
  );
}

function SortIcon({ sorted }: { sorted: false | "asc" | "desc" }) {
  if (sorted === "asc") return <ArrowUpIcon aria-hidden className="size-3.5" />;
  if (sorted === "desc") return <ArrowDownIcon aria-hidden className="size-3.5" />;
  return (
    <ArrowUpDownIcon
      aria-hidden
      className="size-3.5 opacity-25 transition-opacity group-hover:opacity-60 group-focus-visible:opacity-60"
    />
  );
}
