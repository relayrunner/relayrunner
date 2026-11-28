import { describe, expect, test } from "vitest";
import { sortOf, sortParam } from "./search-params";

describe("table sort param", () => {
  test("names the column, with -asc when ascending", () => {
    expect(sortParam({ id: "date", desc: true })).toBe("date");
    expect(sortParam({ id: "date", desc: false })).toBe("date-asc");
  });

  test("reads only the table's own columns", () => {
    const ids = ["number", "date"];
    expect(sortOf("date", ids)).toEqual({ id: "date", desc: true });
    expect(sortOf("number-asc", ids)).toEqual({ id: "number", desc: false });
    expect(sortOf("title", ids)).toBeUndefined();
    expect(sortOf(3, ids)).toBeUndefined();
  });
});
