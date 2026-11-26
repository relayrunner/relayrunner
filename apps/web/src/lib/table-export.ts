// A table's rows as a file to save or text to paste: CSV for spreadsheets, JSON for scripts, and
// Markdown for a chat with a teammate or an agent.

/** One exported column: its heading and a row's value. */
export type ExportColumn<TData> = { header: string; value: (row: TData) => unknown };

/** An epoch-ms time as ISO 8601, for a file; nothing when it's missing. */
export const isoTime = (ms: number | null | undefined) =>
  ms === null || ms === undefined ? null : new Date(ms).toISOString();

/** Milliseconds as seconds to a tenth, for a file; nothing when missing. */
export const seconds = (ms: number | null | undefined) =>
  ms === null || ms === undefined ? null : Math.round(ms / 100) / 10;

/** A cell as plain text: dates in ISO form, lists joined, nothing for a missing value. */
function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(text).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** RFC 4180: a field with a comma, quote or line break goes in quotes, its quotes doubled. */
const csvField = (value: unknown) => {
  const field = text(value);
  return /[",\r\n]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field;
};

export function toCsv<TData>(rows: TData[], columns: ExportColumn<TData>[]) {
  const lines = [columns.map((column) => csvField(column.header))];
  for (const row of rows) lines.push(columns.map((column) => csvField(column.value(row))));
  return `${lines.map((line) => line.join(",")).join("\r\n")}\r\n`;
}

/** One object per row, keyed by heading, with numbers kept as numbers. */
export function toJson<TData>(rows: TData[], columns: ExportColumn<TData>[]) {
  const records = rows.map((row) =>
    Object.fromEntries(
      columns.map((column) => {
        const value = column.value(row);
        return [
          column.header,
          typeof value === "number" || typeof value === "boolean"
            ? value
            : value == null
              ? null
              : text(value),
        ];
      }),
    ),
  );
  return `${JSON.stringify(records, null, 2)}\n`;
}

const markdownCell = (value: unknown) =>
  text(value)
    .replaceAll("|", "\\|")
    .replace(/\s*\n\s*/g, " ");

export function toMarkdown<TData>(rows: TData[], columns: ExportColumn<TData>[]) {
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [
    line(columns.map((column) => markdownCell(column.header))),
    line(columns.map(() => "---")),
    ...rows.map((row) => line(columns.map((column) => markdownCell(column.value(row))))),
  ].join("\n");
}

const FILES = {
  csv: { extension: "csv", type: "text/csv;charset=utf-8", write: toCsv },
  json: { extension: "json", type: "application/json", write: toJson },
} as const;

/** Saves the rows as `<name>-<today>.csv` or `.json` through the browser's download. */
export function downloadRows<TData>(
  format: keyof typeof FILES,
  name: string,
  rows: TData[],
  columns: ExportColumn<TData>[],
) {
  const file = FILES[format];
  const url = URL.createObjectURL(new Blob([file.write(rows, columns)], { type: file.type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${name.replace(/[^\w.-]+/g, "-")}-${new Date().toISOString().slice(0, 10)}.${file.extension}`;
  link.click();
  // After the click has started the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
