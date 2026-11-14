import { AppError } from "@relayrunner/errors";
import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vitest";
import { respondError } from "./errors.ts";

function appThrowing(error: unknown) {
  const routes = new Hono().get("/", () => {
    throw error;
  });
  return new Hono().route("/fail", routes).onError((caught, c) => respondError(c, caught));
}

afterEach(() => vi.restoreAllMocks());

describe("error responses", () => {
  test("an AppError thrown in a sub-router keeps its code, status, details and retry time", async () => {
    const error = new AppError("RATE_LIMITED", { details: { limit: 10 }, retryAfter: 30 });
    const response = await appThrowing(error).request("/fail");
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(await response.json()).toEqual({
      error: {
        code: "RATE_LIMITED",
        message: "Too many requests. Try again shortly.",
        details: { limit: 10 },
      },
    });
  });

  test("anything else is an INTERNAL_ERROR that keeps its message out of the response", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await appThrowing(new Error("D1 exploded")).request("/fail");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Something went wrong on our side." },
    });
    expect(log.mock.calls[0]![0]).toContain("D1 exploded");
  });
});
