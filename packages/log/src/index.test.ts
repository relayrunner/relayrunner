import { afterEach, describe, expect, it, vi } from "vitest";
import { addLogContext, createLogger, serializeError, withLogContext } from "./index.ts";

afterEach(() => vi.restoreAllMocks());

function lines(method: "debug" | "info" | "warn" | "error") {
  const spy = vi.spyOn(console, method).mockImplementation(() => {});
  return () => spy.mock.calls.map(([line]) => JSON.parse(String(line)));
}

describe("createLogger", () => {
  it("writes one JSON line with the core fields first", () => {
    const info = lines("info");
    const log = createLogger({ service: "api", env: "production", version: "v1" });
    log.info("routing.decision", "job routed", { result: "routed", skipped: undefined });
    const [line] = info();
    expect(line).toEqual({
      level: "info",
      event: "routing.decision",
      msg: "job routed",
      service: "api",
      env: "production",
      version: "v1",
      result: "routed",
    });
    expect(Object.keys(line).slice(0, 3)).toEqual(["level", "event", "msg"]);
  });

  it("sends each level to its own console method and drops lines below the level", () => {
    const debug = lines("debug");
    const warn = lines("warn");
    const log = createLogger({ service: "api", level: "info" });
    log.debug("webhook.received", "dropped");
    log.warn("webhook.processed", "kept");
    expect(debug()).toEqual([]);
    expect(warn()).toMatchObject([{ level: "warn", msg: "kept" }]);
  });

  it("reads a lazy config once, on the first line", () => {
    lines("info");
    const config = vi.fn(() => ({ service: "api" }));
    const log = createLogger(config);
    expect(config).not.toHaveBeenCalled();
    log.info("a", "one");
    log.info("a", "two");
    expect(config).toHaveBeenCalledTimes(1);
  });

  it("adds bound fields, then context, with the line's own fields winning", async () => {
    const info = lines("info");
    const log = createLogger({ service: "api" }).with({ workspaceId: "ws_1" });
    await withLogContext({ requestId: "r1", repo: "a/b" }, async () => {
      addLogContext({ userId: "u1" });
      await Promise.resolve();
      log.info("http.request", "done", { repo: "c/d" });
    });
    log.info("http.request", "outside");
    expect(info()).toMatchObject([
      { requestId: "r1", userId: "u1", workspaceId: "ws_1", repo: "c/d" },
      { workspaceId: "ws_1" },
    ]);
    expect(info()[1]).not.toHaveProperty("requestId");
  });

  it("nests contexts without leaking inner fields out", () => {
    const info = lines("info");
    const log = createLogger({ service: "api" });
    withLogContext({ deliveryId: "d1" }, () => {
      withLogContext({ jobId: 7 }, () => log.info("a", "inner"));
      log.info("a", "outer");
    });
    expect(info()).toMatchObject([{ deliveryId: "d1", jobId: 7 }, { deliveryId: "d1" }]);
    expect(info()[1]).not.toHaveProperty("jobId");
  });

  it("serializes errors in any field named error, and Error values anywhere", () => {
    const error = lines("error");
    const log = createLogger({ service: "api" });
    log.error("webhook.processed", "failed", {
      error: "plain string",
      cause: new TypeError("boom"),
    });
    const [line] = error();
    expect(line.error).toEqual({ name: "Error", message: "plain string" });
    expect(line.cause).toMatchObject({ name: "TypeError", message: "boom" });
    expect(line.cause.stack).toContain("boom");
  });

  it("leaves stacks off warnings so Workers Issues doesn't report them", () => {
    const warn = lines("warn");
    const log = createLogger({ service: "api" });
    log.warn("webhook.processed", "retrying", {
      error: new Error("outer", { cause: new Error("inner") }),
    });
    const [line] = warn();
    expect(line.error).toEqual({
      name: "Error",
      message: "outer",
      cause: { name: "Error", message: "inner" },
    });
  });

  it("prints a readable line in pretty format", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    createLogger({ service: "api", format: "pretty" }).info("routing.decision", "job routed", {
      result: "routed",
      jobId: 987,
    });
    expect(String(spy.mock.calls[0]![0])).toMatch(
      /^\d\d:\d\d:\d\d INFO  routing\.decision {2}job routed {2}result=routed jobId=987$/,
    );
  });
});

describe("serializeError", () => {
  it("keeps the cause chain", () => {
    const error = new Error("outer", { cause: new Error("inner") });
    expect(serializeError(error)).toMatchObject({
      message: "outer",
      cause: { message: "inner" },
    });
  });
});
