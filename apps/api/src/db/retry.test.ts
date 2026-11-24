import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestD1 } from "../testing-d1.ts";
import { retryOverloadedReads } from "./retry.ts";

const OVERLOADED = new Error("D1 DB is overloaded. Requests queued for too long.");

// A test D1 whose statements fail with `error` the first `failures` times they run.
function flakyD1(failures: number, error = OVERLOADED) {
  const d1 = createTestD1();
  let left = failures;
  const prepare = d1.prepare.bind(d1);
  d1.prepare = (sql) => {
    const statement = prepare(sql);
    const bind = statement.bind.bind(statement);
    statement.bind = (...values) => {
      const bound = bind(...values);
      const all = bound.all.bind(bound);
      bound.all = (() => (left-- > 0 ? Promise.reject(error) : all())) as typeof bound.all;
      return bound;
    };
    return statement;
  };
  return d1;
}

describe("retryOverloadedReads", () => {
  afterEach(() => vi.useRealTimers());

  async function read(d1: D1Database) {
    vi.useFakeTimers();
    const result = retryOverloadedReads(d1).prepare("select ? as n").bind(1).all();
    const settled = result.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await vi.runAllTimersAsync();
    return settled;
  }

  it("retries a read D1 turned away until it lands", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const outcome = await read(flakyD1(2));
    expect(outcome).toMatchObject({ value: { results: [{ n: 1 }] } });
  });

  it("gives up after the last retry", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await read(flakyD1(3))).toEqual({ error: OVERLOADED });
  });

  it("doesn't retry other errors", async () => {
    const other = new Error("D1_ERROR: no such table: nope");
    expect(await read(flakyD1(1, other))).toEqual({ error: other });
  });

  it("leaves writes alone", async () => {
    const d1 = flakyD1(1);
    const write = retryOverloadedReads(d1).prepare("insert into nope values (?)").bind(1).all();
    await expect(write).rejects.toBe(OVERLOADED);
  });

  it("keeps statements batchable", async () => {
    const d1 = retryOverloadedReads(createTestD1());
    const [first] = await d1.batch([d1.prepare("select ? as n").bind(7)]);
    expect(first!.results).toEqual([{ n: 7 }]);
  });
});
