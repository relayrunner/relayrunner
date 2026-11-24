import { describe, expect, it, vi } from "vitest";
import { DEFAULT_FROM, dashboardUrl, sendEmail } from "./email.ts";
import type { Env } from "./env.ts";

function envWith(send?: (message: unknown) => Promise<unknown>, extra: Partial<Env> = {}) {
  return {
    BETTER_AUTH_URL: "https://auth.example",
    ...(send ? { EMAIL: { send } } : {}),
    ...extra,
  } as unknown as Env;
}

describe("sendEmail", () => {
  it("sends from the RelayRunner sender with text and HTML", async () => {
    const send = vi.fn(async () => ({ messageId: "m" }));
    await sendEmail(envWith(send), { to: "a@example.com", template: "welcome", context: {} });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "a@example.com",
        from: { name: "RelayRunner", email: DEFAULT_FROM },
        subject: "Welcome to RelayRunner",
        text: expect.stringContaining("relayrunner connect"),
        html: expect.stringContaining("<!doctype html>"),
      }),
    );
  });

  it("links the dashboard, not the auth host, when DASHBOARD_URL is set", () => {
    expect(dashboardUrl(envWith(undefined, { DASHBOARD_URL: "https://app.example/" }))).toBe(
      "https://app.example",
    );
    expect(dashboardUrl(envWith())).toBe("https://auth.example");
  });

  it("logs instead of throwing without a binding or when a send fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      sendEmail(envWith(), { to: "a@example.com", template: "welcome", context: {} }),
    ).resolves.toBeUndefined();
    const failing = vi.fn(async () => {
      throw new Error("sender not verified");
    });
    await expect(
      sendEmail(envWith(failing), {
        to: "ops@example.com",
        template: "dead-letter-alert",
        context: { count: 3, threshold: 2 },
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(JSON.parse(error.mock.calls[0]![0] as string)).toMatchObject({
      msg: "email send failed",
      error: { message: "sender not verified" },
    });
    warn.mockRestore();
    error.mockRestore();
  });
});
