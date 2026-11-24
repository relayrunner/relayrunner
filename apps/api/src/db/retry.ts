import { log } from "../log.ts";

// How long to wait before each retry of a read that D1 turned away. D1 sheds load in short bursts
// (a few seconds), so the later tries usually land after it clears.
const RETRY_DELAYS_MS = [300, 1000];

/**
 * `d1` with its reads retried when D1 says it's overloaded. Only SELECTs retry: D1 may have run a
 * write it reports as failed, and running it twice isn't safe. Statements stay D1's own objects,
 * with `bind` and the read methods replaced on each one, so `batch` still accepts them.
 */
export function retryOverloadedReads(d1: D1Database | D1DatabaseSession) {
  // Drizzle and `prepare()` below only call these two.
  return {
    prepare: (sql: string) => withRetries(d1.prepare(sql), sql),
    batch: (statements: D1PreparedStatement[]) => d1.batch(statements),
  } as D1Database;
}

function withRetries(statement: D1PreparedStatement, sql: string): D1PreparedStatement {
  if (!/^\s*select\b/i.test(sql)) return statement;
  const bind = statement.bind.bind(statement);
  statement.bind = (...values) => withRetries(bind(...values), sql);
  for (const method of ["all", "raw", "first", "run"] as const) {
    const call = (statement[method] as (...args: unknown[]) => Promise<unknown>).bind(statement);
    (statement[method] as unknown) = (...args: unknown[]) => retry(() => call(...args), sql);
  }
  return statement;
}

async function retry<T>(read: () => Promise<T>, sql: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isOverloaded(error)) throw error;
      // No error object here: a line with a stack would raise a Workers Issue for a read that
      // may still succeed.
      log.warn("d1.read_retried", "D1 overloaded; retrying read", {
        attempt: attempt + 1,
        table: /\bfrom\s+"?(\w+)/i.exec(sql)?.[1],
      });
      await new Promise((resolve) => setTimeout(resolve, delay * (0.75 + Math.random() / 2)));
    }
  }
}

/** D1's "D1 DB is overloaded. Requests queued for too long." */
function isOverloaded(error: unknown): boolean {
  return error instanceof Error && /D1 DB is overloaded/i.test(error.message);
}
