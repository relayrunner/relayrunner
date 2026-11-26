import { describe, expect, test } from "vitest";
import { type ExportColumn, isoTime, seconds, toCsv, toJson, toMarkdown } from "./table-export";

type Row = { name: string; minutes: number; tags?: string[]; at?: number };
const rows: Row[] = [
  { name: 'Fix "flaky" test, again', minutes: 12.5, tags: ["ci", "tests"], at: 0 },
  { name: "Split | shards\nnow", minutes: 3 },
];
const columns: ExportColumn<Row>[] = [
  { header: "Name", value: (row) => row.name },
  { header: "Minutes", value: (row) => row.minutes },
  { header: "Tags", value: (row) => row.tags },
  { header: "At", value: (row) => isoTime(row.at) },
];

describe("table export", () => {
  test("quotes CSV fields that need it", () => {
    expect(toCsv(rows, columns)).toBe(
      'Name,Minutes,Tags,At\r\n"Fix ""flaky"" test, again",12.5,"ci, tests",1970-01-01T00:00:00.000Z\r\n"Split | shards\nnow",3,,\r\n',
    );
  });

  test("keeps numbers in JSON and missing values as null", () => {
    expect(JSON.parse(toJson(rows, columns))).toEqual([
      {
        Name: 'Fix "flaky" test, again',
        Minutes: 12.5,
        Tags: "ci, tests",
        At: "1970-01-01T00:00:00.000Z",
      },
      { Name: "Split | shards\nnow", Minutes: 3, Tags: null, At: null },
    ]);
  });

  test("escapes pipes and line breaks in Markdown", () => {
    expect(toMarkdown(rows, columns).split("\n")).toEqual([
      "| Name | Minutes | Tags | At |",
      "| --- | --- | --- | --- |",
      '| Fix "flaky" test, again | 12.5 | ci, tests | 1970-01-01T00:00:00.000Z |',
      "| Split \\| shards now | 3 |  |  |",
    ]);
  });

  test("turns milliseconds into seconds", () => {
    expect(seconds(61_234)).toBe(61.2);
    expect(seconds(null)).toBeNull();
  });
});
