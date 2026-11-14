import { describe, expect, test, vi } from "vitest";

const span = vi.hoisted(() => ({
  setAttributes: vi.fn(),
  recordException: vi.fn(),
  setStatus: vi.fn(),
}));
vi.mock("cloudflare:workers", () => ({
  tracing: {
    enterSpan: (_name: string, callback: (s: typeof span) => unknown) => callback(span),
    getActiveSpan: () => span,
  },
}));

const { annotate, traced } = await import("./tracing.ts");

describe("traced", () => {
  test("tags the span and returns the result", async () => {
    const result = await traced(
      "work",
      { "github.job_id": 42, "github.action": null },
      async () => "done",
    );
    expect(result).toBe("done");
    expect(span.setAttributes).toHaveBeenCalledWith({
      "github.job_id": 42,
      "github.action": undefined,
    });
  });

  test("marks the span as an error and rethrows", async () => {
    const error = new Error("boom");
    await expect(
      traced("work", {}, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(span.recordException).toHaveBeenCalledWith(error);
    expect(span.setStatus).toHaveBeenCalledWith({ code: "error", message: "boom" });
  });
});

test("annotate tags the active span", () => {
  annotate({ "relayrunner.runner": "ubuntu-latest" });
  expect(span.setAttributes).toHaveBeenLastCalledWith({ "relayrunner.runner": "ubuntu-latest" });
});
