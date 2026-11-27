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
  useMemo,
  useRef,
  useState,
} from "react";
import { ExportMenu } from "@/components/export-menu";
import { InfoTip } from "@/components/ui/info-tip";
import {
  PHONE_HIDDEN,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ExportColumn } from "@/lib/table-export";
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
  /** Leave the column out on phones, for a figure the row's other columns or page already give. */
  hideOnPhone?: boolean;
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

type RowClassName<TData extends RowData> = (
  row: Row<typeof features, TData>,
  around: { previous?: Row<typeof features, TData>; next?: Row<typeof features, TData> },
) => string | undefined;

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
  fullRow,
  sectionOf,
  exportAs,
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
  /** A row's classes, which can look at the rows shown either side of it. */
  rowClassName?: RowClassName<TData>;
  /** What a row shows across the whole width instead of its cells, such as a group's heading. */
  fullRow?: (row: TData) => ReactNode;
  /**
   * A heading for the rows a top-level row starts, such as its day. It shows above each row whose
   * heading differs from the one before, while the table is in the data's own order.
   */
  sectionOf?: (row: TData) => string;
  /**
   * Shows an Export menu above the table, saving or copying its rows as filtered and sorted:
   * `name` starts the file's name, and `columns` are what each row exports as. These are their own
   * list, since a cell's sort key or display text rarely makes a good value in a file. Rows with
   * subRows are headings over them, so only the rows under them export.
   */
  exportAs?: { name: string; columns: ExportColumn<TData>[] };
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
  const items = useMemo(
    () => withSections(rows, sorting.length ? undefined : sectionOf),
    [rows, sorting, sectionOf],
  );

  const tableElement = (
    <Table className="tabular-nums">
      {caption && <TableCaption>{caption}</TableCaption>}
      <TableHeader>
        <TableRow>
          {headers.map((header) => {
            const sorted = header.column.getIsSorted();
            const { align, info, label, hideOnPhone } = header.column.columnDef.meta ?? {};
            const title = header.column.columnDef.header;
            return (
              <TableHead
                key={header.id}
                aria-sort={sorted ? ARIA_SORT[sorted] : undefined}
                className={cn(align === "end" && "text-right", hideOnPhone && PHONE_HIDDEN)}
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
      ) : items.length > VIRTUALIZE_ABOVE ? (
        <VirtualRows
          items={items}
          columns={headers.length}
          rowHeight={rowHeight}
          rowClassName={rowClassName}
          fullRow={fullRow}
        />
      ) : (
        <TableBody>
          {items.map((item) =>
            "section" in item ? (
              <SectionRow key={item.key} label={item.section} columns={headers.length} />
            ) : (
              <DataRow
                key={item.row.id}
                row={item.row}
                expanded={item.row.getIsExpanded()}
                className={rowClassName?.(item.row, item.around)}
                full={fullRow?.(item.row.original)}
              />
            ),
          )}
        </TableBody>
      )}
    </Table>
  );
  if (!exportAs) return tableElement;
  return (
    <div className="grid gap-1">
      <div className="-mt-1 flex justify-end">
        <ExportMenu
          name={exportAs.name}
          columns={exportAs.columns}
          rows={() =>
            table
              .getSortedRowModel()
              .flatRows.filter((row) => !row.subRows.length)
              .map((row) => row.original)
          }
        />
      </div>
      {tableElement}
    </div>
  );
}

/** A row and where it sits among the rows, or a heading over the rows after it. */
type Item<TData extends RowData> =
  | {
      row: Row<typeof features, TData>;
      around: { previous?: Row<typeof features, TData>; next?: Row<typeof features, TData> };
    }
  | { section: string; key: string };

/** A section heading's look, shared with lists that aren't tables (History's Workflows). */
export const SECTION_HEADING =
  "bg-secondary/30 px-3 py-1.5 text-xs sm:px-4 font-medium text-muted-foreground";

/** The rows with a heading above each top-level row that starts a new section. */
function withSections<TData extends RowData>(
  rows: Row<typeof features, TData>[],
  sectionOf?: (row: TData) => string,
): Item<TData>[] {
  const items: Item<TData>[] = [];
  let last: string | undefined;
  rows.forEach((row, index) => {
    if (sectionOf && row.depth === 0) {
      const section = sectionOf(row.original);
      if (section !== last) items.push({ section, key: `section:${row.id}` });
      last = section;
    }
    items.push({ row, around: { previous: rows[index - 1], next: rows[index + 1] } });
  });
  return items;
}

function SectionRow({
  label,
  columns,
  index,
  measure,
}: {
  label: string;
  columns: number;
  index?: number;
  measure?: (element: HTMLTableRowElement | null) => void;
}) {
  return (
    <TableRow data-index={index} ref={measure} className="hover:bg-transparent">
      <TableCell colSpan={columns} className={SECTION_HEADING}>
        {label}
      </TableCell>
    </TableRow>
  );
}

type DataRowProps<TData extends RowData> = {
  row: Row<typeof features, TData>;
  /** Passed so a memoized row re-renders when it opens or closes. */
  expanded: boolean;
  className?: string;
  /** Shown across the row in place of its cells. */
  full?: ReactNode;
  index?: number;
  measure?: (element: HTMLTableRowElement | null) => void;
};

// Memoized: rows re-render on scroll only when they enter the window, not every frame.
const DataRow = memo(function DataRow<TData extends RowData>({
  row,
  className,
  full,
  index,
  measure,
}: DataRowProps<TData>) {
  const cells = row.getAllCells();
  return (
    <TableRow data-index={index} ref={measure} className={className}>
      {full ? (
        <TableCell colSpan={cells.length}>{full}</TableCell>
      ) : (
        cells.map((cell) => (
          <TableCell
            key={cell.id}
            className={cn(
              cell.column.columnDef.meta?.align === "end" && "text-right",
              cell.column.columnDef.meta?.hideOnPhone && PHONE_HIDDEN,
              cell.column.columnDef.meta?.className,
            )}
          >
            <FlexRender cell={cell} />
          </TableCell>
        ))
      )}
    </TableRow>
  );
}) as <TData extends RowData>(props: DataRowProps<TData>) => ReactNode;

// Window-scrolled rows with spacer rows above and below, so the markup stays a real <table>
// and columns keep their natural widths.
function VirtualRows<TData extends RowData>({
  items: list,
  columns,
  rowHeight,
  rowClassName,
  fullRow,
}: {
  items: Item<TData>[];
  columns: number;
  rowHeight: number;
  rowClassName?: RowClassName<TData>;
  fullRow?: (row: TData) => ReactNode;
}) {
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const [offset, setOffset] = useState(0);
  useLayoutEffect(() => {
    const top = bodyRef.current?.getBoundingClientRect().top;
    if (top !== undefined) setOffset(top + window.scrollY);
  }, []);

  const virtualizer = useWindowVirtualizer({
    count: list.length,
    estimateSize: useCallback(() => rowHeight, [rowHeight]),
    overscan: 10,
    scrollMargin: offset,
    // Stable between renders: the virtualizer re-measures every row when this changes.
    getItemKey: useCallback(
      (index: number) => {
        const item = list[index]!;
        return "section" in item ? item.key : item.row.id;
      },
      [list],
    ),
  });
  const items = virtualizer.getVirtualItems();
  const before = items.length ? items[0]!.start - offset : 0;
  const after = items.length ? virtualizer.getTotalSize() - (items.at(-1)!.end - offset) : 0;

  return (
    <TableBody ref={bodyRef}>
      {before > 0 && <Spacer height={before} columns={columns} />}
      {items.map((virtual) => {
        const item = list[virtual.index]!;
        if ("section" in item) {
          return (
            <SectionRow
              key={virtual.key}
              label={item.section}
              columns={columns}
              index={virtual.index}
              measure={virtualizer.measureElement}
            />
          );
        }
        const { row, around } = item;
        return (
          <DataRow
            key={virtual.key}
            row={row}
            expanded={row.getIsExpanded()}
            className={rowClassName?.(row, around)}
            full={fullRow?.(row.original)}
            index={virtual.index}
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
