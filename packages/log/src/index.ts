/**
 * The Workers' one logger. Every line is a single JSON object with the same core fields, so
 * Workers Observability and Grafana can filter, count and chart it (docs/observability.md):
 *
 *   { "level": "info", "event": "routing.decision", "msg": "job routed", "service": "api", … }
 *
 * `event` is the stable name dashboards and alerts key on; `msg` is for people and can change.
 * Fields from the surrounding context (withLogContext: the request, delivery or job being worked
 * on) are added to every line, and an `error` field of any thrown value becomes
 * `{ name, message, stack }`.
 */
// The Workers' tsconfigs leave out Node's types; nodejs_compat provides the module at run time.
// @ts-ignore
import { AsyncLocalStorage } from "node:async_hooks";

export type Level = "debug" | "info" | "warn" | "error";
export type Fields = Record<string, unknown>;

export interface Logger<Event extends string = string> {
  debug(event: Event, msg: string, fields?: Fields): void;
  info(event: Event, msg: string, fields?: Fields): void;
  warn(event: Event, msg: string, fields?: Fields): void;
  error(event: Event, msg: string, fields?: Fields): void;
  /** A logger that adds `fields` to every line it writes. */
  with(fields: Fields): Logger<Event>;
}

export interface LogConfig {
  service: string;
  // Such as "production" or "development".
  env?: string;
  // The deployed version (a Workers version id), to tell lines from before and after a deploy.
  version?: string;
  // Lines below this level are dropped. Defaults to "info".
  level?: Level;
  // "json" (the default) for Workers Observability; "pretty" for a terminal.
  format?: "json" | "pretty";
}

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

interface ContextStorage {
  run<R>(store: Fields, fn: () => R): R;
  getStore(): Fields | undefined;
}

const context: ContextStorage = new AsyncLocalStorage();

/**
 * Run `fn` with `fields` added to every line logged inside it, on top of any outer context. Use it
 * at each entry point: a request, a queue message, a cron run, a Durable Object call.
 */
export function withLogContext<T>(fields: Fields, fn: () => T): T {
  return context.run({ ...context.getStore(), ...defined(fields) }, fn);
}

/**
 * Add fields to the current context, such as a request's user once its session is read. Lines
 * logged earlier don't get them. Does nothing outside withLogContext.
 */
export function addLogContext(fields: Fields) {
  const store = context.getStore();
  if (store) Object.assign(store, defined(fields));
}

/**
 * A logger for one Worker. `config` is read on the first line, not at import, so it can read
 * bindings that only exist once the Worker runs.
 */
export function createLogger<Event extends string = string>(
  config: LogConfig | (() => LogConfig),
): Logger<Event> {
  let resolved: LogConfig | undefined;
  const settings = () => (resolved ??= typeof config === "function" ? config() : config);
  const make = (bound: Fields): Logger<Event> => {
    const write = (level: Level) => (event: Event, msg: string, fields?: Fields) => {
      const conf = settings();
      if (RANK[level] < RANK[conf.level ?? "info"]) return;
      const line = record(level, event, msg, conf, { ...bound, ...fields });
      sink(level)(conf.format === "pretty" ? pretty(line) : JSON.stringify(line));
    };
    return {
      debug: write("debug"),
      info: write("info"),
      warn: write("warn"),
      error: write("error"),
      with: (fields) => make({ ...bound, ...fields }),
    };
  };
  return make({});
}

// The line's fields, in a fixed order: level, event and msg first so a raw line reads at a glance,
// then where it came from, the context, and the line's own fields, which win over the context's.
function record(level: Level, event: string, msg: string, conf: LogConfig, fields: Fields) {
  const line: Fields = {
    level,
    event,
    msg,
    service: conf.service,
    ...defined({ env: conf.env, version: conf.version }),
    ...context.getStore(),
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    line[key] = key === "error" || value instanceof Error ? serializeError(value) : value;
  }
  return line;
}

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  cause?: SerializedError;
}

/** Any thrown value as `{ name, message, stack, cause }`. */
export function serializeError(error: unknown, depth = 0): SerializedError {
  if (!(error instanceof Error)) return { name: "Error", message: String(error) };
  return {
    name: error.name,
    message: error.message,
    ...(error.stack ? { stack: error.stack } : {}),
    ...(error.cause !== undefined && depth < 3
      ? { cause: serializeError(error.cause, depth + 1) }
      : {}),
  };
}

// One line for a terminal: `14:02:11 INFO routing.decision  job routed  result=routed …`.
function pretty({ level, event, msg, service: _s, env: _e, version: _v, ...rest }: Fields) {
  const time = new Date().toISOString().slice(11, 19);
  const pairs = Object.entries(rest)
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" ");
  return `${time} ${String(level).toUpperCase().padEnd(5)} ${event}  ${msg}${pairs ? `  ${pairs}` : ""}`;
}

// Each level goes to its own console method, so Workers Observability's level filter matches.
// Looked up per line, so a test's console spy sees it.
function sink(level: Level): (line: string) => void {
  return (line) => console[level](line);
}

function defined(fields: Fields): Fields {
  const out: Fields = {};
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) out[key] = value;
  return out;
}
