import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

// An in-memory D1 for tests, on Node's built-in SQLite, so a query costs microseconds instead of a
// round trip to workerd. It covers the D1 API the app and Drizzle use: prepare/bind/first/all/
// run/raw, batch, exec and withSession.
export function createTestD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  const cache = new Map<string, StatementSync>();
  const compile = (sql: string) => {
    let statement = cache.get(sql);
    if (!statement) cache.set(sql, (statement = db.prepare(sql)));
    return statement;
  };
  const totals = db.prepare("select total_changes() as n");
  const totalChanges = () => Number(totals.get()!.n);
  const lastRowId = db.prepare("select last_insert_rowid() as id");

  class Statement {
    constructor(
      readonly sql: string,
      readonly params: SQLInputValue[] = [],
    ) {}
    bind(...values: unknown[]) {
      // SQLite takes thousands of bound values; D1 takes 100 and fails the query.
      if (values.length > 100)
        throw new Error(
          `D1_ERROR: too many SQL variables at offset ${values.length}: SQLITE_ERROR`,
        );
      return new Statement(this.sql, values.map(toSql));
    }
    #rows() {
      const statement = compile(this.sql);
      const before = totalChanges();
      // Writes without RETURNING give no rows, like D1.
      const results =
        statement.columns().length === 0
          ? (statement.run(...this.params), [])
          : statement.all(...this.params).map(fromRow);
      const changes = totalChanges() - before;
      return { results, meta: meta(changes, Number(lastRowId.get()!.id)) };
    }
    async all() {
      return { success: true, ...this.#rows() };
    }
    async run() {
      return this.all();
    }
    async first(column?: string) {
      const row = this.#rows().results[0];
      if (!row) return null;
      return column === undefined ? row : row[column];
    }
    async raw({ columnNames = false }: { columnNames?: boolean } = {}) {
      const statement = compile(this.sql);
      statement.setReturnArrays(true);
      try {
        const rows = statement.all(...this.params) as unknown as unknown[][];
        const values = rows.map((row) => row.map(fromValue));
        return columnNames ? [statement.columns().map((c) => c.name), ...values] : values;
      } finally {
        statement.setReturnArrays(false);
      }
    }
  }

  const d1 = {
    prepare: (sql: string) => new Statement(sql),
    // D1 runs a batch as one transaction.
    async batch(statements: Statement[]) {
      db.exec("begin");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.all());
        db.exec("commit");
        return results;
      } catch (error) {
        db.exec("rollback");
        throw error;
      }
    },
    async exec(sql: string) {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
    // Sessions hand back a bookmark like D1's, which moves on with every write.
    withSession: () => ({ ...d1, getBookmark: () => `bookmark-${totalChanges()}` }),
    dump: () => {
      throw new Error("dump isn't supported in tests");
    },
  };
  return d1 as unknown as D1Database;
}

function toSql(value: unknown): SQLInputValue {
  if (value === undefined) throw new Error("D1_TYPE_ERROR: Type 'undefined' not supported");
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return value as SQLInputValue;
}

// D1 hands blobs back as arrays of bytes.
function fromValue(value: unknown) {
  return value instanceof Uint8Array ? [...value] : value;
}

function fromRow(row: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const key in row) out[key] = fromValue(row[key]);
  return out;
}

function meta(changes: number, lastRowId: number) {
  return {
    changes,
    last_row_id: lastRowId,
    changed_db: changes > 0,
    duration: 0,
    rows_read: 0,
    rows_written: changes,
    size_after: 0,
  };
}
