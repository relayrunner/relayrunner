import { describe, expect, test } from "vitest";
import { AppError, ERRORS, parseError } from "./index.ts";

describe("ERRORS", () => {
  test("every code is SCREAMING_SNAKE_CASE with an HTTP error status and a sentence", () => {
    for (const [code, spec] of Object.entries(ERRORS)) {
      expect(code).toMatch(/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/);
      expect(spec.status).toBeGreaterThanOrEqual(400);
      expect(spec.status).toBeLessThan(600);
      expect(spec.message).toMatch(/^[A-Z].*\.$/);
    }
  });
});

describe("AppError", () => {
  test("takes its status and default message from the code", () => {
    const error = new AppError("NOT_FOUND");
    expect(error).toBeInstanceOf(Error);
    expect(error.status).toBe(404);
    expect(error.toJSON()).toEqual({ error: { code: "NOT_FOUND", message: "Not found." } });
  });

  test("carries its own message and details", () => {
    const error = new AppError("INVALID_REQUEST", {
      message: "Pick one.",
      details: { fields: ["a"] },
    });
    expect(error.toJSON()).toEqual({
      error: { code: "INVALID_REQUEST", message: "Pick one.", details: { fields: ["a"] } },
    });
  });
});

describe("parseError", () => {
  test("reads an error body back", () => {
    const sent = new AppError("PROVIDER_EXISTS", { details: { id: "acme" } });
    const read = parseError(JSON.parse(JSON.stringify(sent)), 409);
    expect(read).toMatchObject({ code: "PROVIDER_EXISTS", status: 409, details: { id: "acme" } });
    expect(read.message).toBe(sent.message);
  });

  test("keeps a code this build doesn't know", () => {
    const read = parseError({ error: { code: "SOMETHING_NEW", message: "New." } }, 418);
    expect(read).toMatchObject({ code: "SOMETHING_NEW", status: 418, message: "New." });
  });

  test("never throws on a body that isn't an error", () => {
    for (const body of [null, "<html>", { error: "not_found" }, {}]) {
      expect(parseError(body, 502)).toMatchObject({
        code: "INTERNAL_ERROR",
        status: 502,
        message: "The request failed with status 502.",
      });
    }
  });
});
